<#
.SYNOPSIS
  Validate LiteLLM prompt-caching behaviour from the live VS Code output-channel log.

.DESCRIPTION
  Locates the most-recently-written "*LiteLLM*" output-channel log under
  %APPDATA%\Code\logs, parses each "Sending chat request" block (with its
  embedded `caching` plan) and pairs it with the following "Token usage" block.
  Prints a per-turn table correlating the resolved cache plan with the actual
  cache_creation / cache_read token counts returned by the backend.

  This turns the manual A/B prompt testing into an at-a-glance pass/fail check:
    - Turn 1 (cold)        => cache_creation > 0, cache_read == 0
    - Turn 2+ (warm)       => cache_read > 0  (the v0.2.8 win)
    - mode "off"           => active:false AND cache_read == 0 on every turn

  It also verifies the rolling-last placement strategy. For each active turn it
  reads the resolved placement mode (rollingLast = "<ttl>/<placement>") and the
  message that actually received the marker (rollingPlacedOn) and reports:
    - stableTurnsOnly + placedOn user/assistant => OK (a tool tail, if present,
      was correctly skipped)
    - stableTurnsOnly + placedOn tool           => VIOLATION (must never happen)
    - always + placedOn tool                    => expected
    - never + any placement                     => VIOLATION
  The ROLLING summary line confirms stableTurnsOnly never tagged a tool result.

.PARAMETER LogPath
  Optional explicit path to a LiteLLM log file. If omitted, the newest live log
  is auto-discovered.

.PARAMETER Tail
  Only consider the last N turns (default: all turns in the file).

.PARAMETER Watch
  Re-run every 5 seconds (Ctrl+C to stop) so you can leave it open while you
  drive the chat turns.

.EXAMPLE
  pwsh -File scripts/validate-cache-log.ps1

.EXAMPLE
  pwsh -File scripts/validate-cache-log.ps1 -Tail 6 -Watch
#>
[CmdletBinding()]
param(
	[string]$LogPath,
	[int]$Tail = 0,
	[switch]$Watch
)

function Resolve-LiteLLMLog {
	param([string]$Explicit)
	if ($Explicit) {
		if (-not (Test-Path $Explicit)) { throw "Log file not found: $Explicit" }
		return (Get-Item $Explicit)
	}
	$root = Join-Path $env:APPDATA "Code\logs"
	if (-not (Test-Path $root)) { throw "VS Code logs directory not found: $root" }
	$log = Get-ChildItem -Path $root -Recurse -Filter "*LiteLLM*" -ErrorAction SilentlyContinue |
		Sort-Object LastWriteTime -Descending | Select-Object -First 1
	if (-not $log) { throw "No *LiteLLM* output-channel log found under $root" }
	return $log
}

function Parse-Turns {
	param([string]$Content)

	# Split the file into timestamped blocks. Each block starts with [ISO-8601]
	# and runs until the next [ISO-8601] line (or EOF). The body may be a
	# multi-line nested JSON object, so we anchor on the timestamp boundary.
	$blocks = [System.Collections.Generic.List[object]]::new()
	$pattern = '(?ms)^\[(?<ts>\d{4}-\d{2}-\d{2}T[^\]]+)\]\s*(?<label>[^\r\n{]*?)\s*(?<body>\{.*?)?(?=^\[\d{4}-\d{2}-\d{2}T|\z)'
	foreach ($m in [regex]::Matches($Content, $pattern)) {
		$blocks.Add([pscustomobject]@{
			Ts    = $m.Groups['ts'].Value
			Label = $m.Groups['label'].Value.Trim()
			Body  = $m.Groups['body'].Value.Trim()
		})
	}

	$turns = [System.Collections.Generic.List[object]]::new()
	$pending = $null
	foreach ($b in $blocks) {
		if ($b.Label -like 'Sending chat request*') {
			$json = $null
			try { $json = $b.Body | ConvertFrom-Json } catch {}
			$pending = [pscustomobject]@{
				ReqTs        = $b.Ts
				ModelId      = $json.modelId
				MessageCount = $json.messageCount
				Caching      = $json.caching
			}
		}
		elseif ($b.Label -like 'Token usage*') {
			$json = $null
			try { $json = $b.Body | ConvertFrom-Json } catch {}
			if ($null -ne $json) {
				$create = [int]($json.cache_creation_input_tokens)
				$read   = [int]($json.cache_read_input_tokens)
				$prompt = [int]($json.prompt_tokens)
				$turns.Add([pscustomobject]@{
					ReqTs        = if ($pending) { $pending.ReqTs } else { $b.Ts }
					UsageTs      = $b.Ts
					ModelId      = if ($pending) { $pending.ModelId } else { $json.model }
					MessageCount = if ($pending) { $pending.MessageCount } else { $null }
					Mode         = if ($pending -and $pending.Caching) { $pending.Caching.mode } else { $null }
					Active       = if ($pending -and $pending.Caching) { $pending.Caching.active } else { $null }
					Tools        = if ($pending -and $pending.Caching) { $pending.Caching.tools } else { $null }
					System       = if ($pending -and $pending.Caching) { $pending.Caching.system } else { $null }
					FirstUser    = if ($pending -and $pending.Caching) { $pending.Caching.firstUser } else { $null }
					RollingLast  = if ($pending -and $pending.Caching) { $pending.Caching.rollingLast } else { $null }
					PlacedOn     = if ($pending -and $pending.Caching) { $pending.Caching.rollingPlacedOn } else { $null }
					PromptTokens = $prompt
					Creation     = $create
					Read         = $read
				})
				$pending = $null
			}
		}
	}
	return $turns
}

function Split-Rolling {
	# Splits the "rollingLast" diagnostic field ("5m/stableTurnsOnly" or "off")
	# into its TTL and placement-mode components.
	param([string]$RollingLast)
	if ([string]::IsNullOrWhiteSpace($RollingLast) -or $RollingLast -eq 'off') {
		return [pscustomobject]@{ Ttl = $null; Placement = $null }
	}
	$parts = $RollingLast -split '/', 2
	return [pscustomobject]@{
		Ttl       = $parts[0]
		Placement = if ($parts.Count -gt 1) { $parts[1] } else { $null }
	}
}

function Get-RollingVerdict {
	# Interprets where the rolling-last cache_control marker landed against the
	# active placement mode. The key thing we want to PROVE for stableTurnsOnly:
	# the marker is NEVER attached to a tool result (role "tool").
	#
	# Returns an object: { Text; Color; IsToolTailSkip; IsViolation }
	param([string]$Placement, [string]$PlacedOn)

	$placedOn = if ([string]::IsNullOrWhiteSpace($PlacedOn)) { 'skipped' } else { $PlacedOn }

	switch ($Placement) {
		'stableTurnsOnly' {
			if ($placedOn -eq 'tool') {
				return [pscustomobject]@{
					Text = "rolling VIOLATION: stableTurnsOnly tagged a TOOL result (should skip it)"
					Color = 'Red'; IsToolTailSkip = $false; IsViolation = $true
				}
			}
			elseif ($placedOn -eq 'assistant' -or $placedOn -eq 'user') {
				return [pscustomobject]@{
					Text = "rolling OK: stableTurnsOnly placed on '$placedOn' (tool result, if any, was skipped)"
					Color = 'Green'; IsToolTailSkip = $true; IsViolation = $false
				}
			}
			else {
				return [pscustomobject]@{
					Text = "rolling: stableTurnsOnly placed nothing (no eligible stable turn)"
					Color = 'DarkGray'; IsToolTailSkip = $false; IsViolation = $false
				}
			}
		}
		'always' {
			$note = if ($placedOn -eq 'tool') { " (tool tail tagged - expected for 'always')" } else { "" }
			return [pscustomobject]@{
				Text = "rolling: always placed on '$placedOn'$note"
				Color = 'DarkGray'; IsToolTailSkip = $false; IsViolation = $false
			}
		}
		'never' {
			$viol = ($placedOn -ne 'skipped')
			return [pscustomobject]@{
				Text = if ($viol) { "rolling VIOLATION: 'never' but marker landed on '$placedOn'" } else { "rolling: never (no marker) - OK" }
				Color = if ($viol) { 'Red' } else { 'DarkGray' }
				IsToolTailSkip = $false; IsViolation = $viol
			}
		}
		default {
			return [pscustomobject]@{
				Text = "rolling: placement n/a (placedOn=$placedOn)"
				Color = 'DarkGray'; IsToolTailSkip = $false; IsViolation = $false
			}
		}
	}
}

function Show-Report {
	param([object]$Log, [int]$Tail)

	$content = Get-Content -Raw -LiteralPath $Log.FullName
	$turns = Parse-Turns -Content $content
	if ($Tail -gt 0 -and $turns.Count -gt $Tail) {
		$turns = $turns[($turns.Count - $Tail)..($turns.Count - 1)]
	}

	Clear-Host
	Write-Host "LiteLLM cache validation" -ForegroundColor Cyan
	Write-Host ("Log: {0}" -f $Log.FullName) -ForegroundColor DarkGray
	Write-Host ("LastWrite: {0}   Turns parsed: {1}" -f $Log.LastWriteTime, $turns.Count) -ForegroundColor DarkGray
	Write-Host ""

	if ($turns.Count -eq 0) {
		Write-Host "No completed chat turns found yet. Send a prompt, then re-run." -ForegroundColor Yellow
		return
	}

	$i = 0
	$firstSeen = $false
	$toolTailSkips = 0
	$rollingViolations = 0
	foreach ($t in $turns) {
		$i++
		# Verdict logic.
		$verdict = ""
		$color = "Gray"
		if ($t.Active -eq $false) {
			if ($t.Read -gt 0) { $verdict = "UNEXPECTED read while caching OFF"; $color = "Red" }
			else { $verdict = "caching OFF (no read) - OK"; $color = "DarkGray" }
		}
		elseif (-not $firstSeen) {
			if ($t.Read -eq 0 -and $t.Creation -gt 0) { $verdict = "COLD write (expected on 1st turn)"; $color = "Yellow" }
			elseif ($t.Read -gt 0) { $verdict = "WARM read (prefix already cached)"; $color = "Green" }
			else { $verdict = "no cache activity"; $color = "Red" }
			$firstSeen = $true
		}
		else {
			if ($t.Read -gt 0) { $verdict = "WARM read - PASS"; $color = "Green" }
			else { $verdict = "MISS (read==0 on warm turn)"; $color = "Red" }
		}

		$pct = if ($t.PromptTokens -gt 0) { [math]::Round(100.0 * $t.Read / $t.PromptTokens, 1) } else { 0 }

		Write-Host ("#{0}  msg={1}  mode={2} active={3}" -f $i, $t.MessageCount, $t.Mode, $t.Active)
		if ($t.Active -eq $true) {
			Write-Host ("     plan: tools={0} system={1} firstUser={2} rolling={3} placedOn={4}" -f `
				$t.Tools, $t.System, $t.FirstUser, $t.RollingLast, $t.PlacedOn) -ForegroundColor DarkGray
		}
		Write-Host ("     tokens: prompt={0}  creation={1}  read={2}  (read {3}% of prompt)" -f `
			$t.PromptTokens, $t.Creation, $t.Read, $pct) -ForegroundColor DarkGray
		Write-Host ("     => {0}" -f $verdict) -ForegroundColor $color

		# Rolling-placement verdict (proves stableTurnsOnly skips tool tails).
		if ($t.Active -eq $true) {
			$split = Split-Rolling -RollingLast $t.RollingLast
			if ($split.Placement) {
				$rv = Get-RollingVerdict -Placement $split.Placement -PlacedOn $t.PlacedOn
				if ($rv.IsToolTailSkip) { $toolTailSkips++ }
				if ($rv.IsViolation) { $rollingViolations++ }
				Write-Host ("     => {0}" -f $rv.Text) -ForegroundColor $rv.Color
			}
		}
		Write-Host ""
	}

	# Summary line.
	$warm = $turns | Where-Object { $_.Active -eq $true } | Select-Object -Skip 1
	if ($warm) {
		$hits = ($warm | Where-Object { $_.Read -gt 0 }).Count
		$tot = $warm.Count
		$sumColor = if ($hits -eq $tot) { "Green" } else { "Red" }
		Write-Host ("SUMMARY: {0}/{1} warm turns reused cache." -f $hits, $tot) -ForegroundColor $sumColor
	}

	# Rolling-placement summary: did stableTurnsOnly ever tag a tool result?
	if ($rollingViolations -gt 0) {
		Write-Host ("ROLLING: {0} placement VIOLATION(s) detected (see red lines above)." -f $rollingViolations) -ForegroundColor Red
	}
	elseif ($toolTailSkips -gt 0) {
		Write-Host ("ROLLING: stableTurnsOnly verified - {0} turn(s) placed on a stable user/assistant turn, 0 tool results tagged." -f $toolTailSkips) -ForegroundColor Green
	}
	else {
		Write-Host "ROLLING: no stableTurnsOnly placements observed yet (run a tool-using agent turn)." -ForegroundColor DarkGray
	}
}

$log = Resolve-LiteLLMLog -Explicit $LogPath
if ($Watch) {
	while ($true) {
		$log = Resolve-LiteLLMLog -Explicit $LogPath
		Show-Report -Log $log -Tail $Tail
		Write-Host "(watching - Ctrl+C to stop)" -ForegroundColor DarkGray
		Start-Sleep -Seconds 5
	}
}
else {
	Show-Report -Log $log -Tail $Tail
}
