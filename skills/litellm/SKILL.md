---
name: litellm
description: Use when the user asks about their LiteLLM setup in VS Code - a model missing from the picker, a server that will not connect, an auth, timeout, or empty-answer error, what a model supports, or changing a LiteLLM extension setting, server, or model record.
argument-hint: "[what to check or change]"
---

# LiteLLM setup

The LiteLLM extension ships tools that read and change its own setup. Use them: they answer from the state the LiteLLM dashboard shows. Never guess a server, a model, or a setting, and never edit `settings.json` by hand in their place.

## A worked case

The user says a model is missing from the model picker.

1. `litellm_diagnostics` shows that server's row in an error state, classified as a rejected key.
2. Say so. `litellm_save_server` sets the key again with the value left out, and VS Code asks the user to type it.
3. `litellm_diagnostics` again: the row is healthy and counts the models it serves.

Diagnose, change one thing, read it back. The sections below are those three moves in general form.

## Check the tools are on

The tools are opt-in. When `litellm_diagnostics` is not among your tools, stop and tell the user to turn on `litellm-vscode-chat.agentTools.enabled`, then ask again.

A write tool can be missing while the read tools work, because each write has its own switch. Name that one switch from the second table and stop. Only the user can turn a switch on.

The tools also need a VS Code window with the extension running. In a session that has none, send the user to the dashboard instead: the `LiteLLM: Open Dashboard` command.

## Read first

| The question                                             | Call                     |
| -------------------------------------------------------- | ------------------------ |
| something fails, is missing, or answers empty            | `litellm_diagnostics`    |
| which servers, settings, or models exist                 | `litellm_configuration`  |
| what one model supports, and where each value comes from | `litellm_inspect_model`  |
| a model's published context window, or its catalog ID    | `litellm_search_catalog` |

Start every "it does not work" question with `litellm_diagnostics`. Its server rows and latest error usually name the cause: a refused connection, a rejected key, a timeout, or a server that serves no models.

`litellm_configuration` can be large. Pass `sections` to read only the slice the question needs.

## Change one thing, then read it back

| To change                                                    | Call                         | Its switch                                                |
| ------------------------------------------------------------ | ---------------------------- | --------------------------------------------------------- |
| a plain setting: a timeout, a toggle, a feature's model      | `litellm_set_setting`        | `litellm-vscode-chat.agentTools.setSetting.enabled`       |
| a model's capabilities or request parameters                 | `litellm_edit_model_records` | `litellm-vscode-chat.agentTools.editModelRecords.enabled` |
| add, edit, or rename a server                                | `litellm_save_server`        | `litellm-vscode-chat.agentTools.saveServer.enabled`       |
| remove a server, or hide a provider group                    | `litellm_remove_server`      | `litellm-vscode-chat.agentTools.removeServer.enabled`     |
| test a connection, sync models, refresh the catalog or usage | `litellm_run_action`         | `litellm-vscode-chat.agentTools.runAction.enabled`        |

Every change takes the same three steps:

1. Read the current value with the matching read tool. Before a model record edit that is `litellm_inspect_model`, so the edit lands on the source that sets the value.
2. Make one change. VS Code shows the user a confirmation card before it runs.
3. Read the value back and say what changed.

A refusal says what is wrong with the input. Correct the input and call again.

## Rules

- **Secrets stay out of the chat.** Never ask for an API key in a message. Tell `litellm_save_server` where the key goes and leave the value out. VS Code asks the user to type it.
- **A probe can cost money.** `litellm_run_action` with `testFeatureModel` sends a real model request. Say so before calling it.
- **The tools change this extension, never the LiteLLM proxy.** When the proxy is the cause, such as a model it does not serve or a key it rejects, say so and say what to change there.
