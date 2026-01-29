#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const packageJsonPath = path.join(__dirname, "..", "package.json");
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));

// Get the version bump type from command line args (patch, minor, major)
const bumpType = process.argv[2] || "patch";

if (!["patch", "minor", "major"].includes(bumpType)) {
	console.error("Usage: npm run bump-version [patch|minor|major]");
	console.error("  patch: 0.1.0 -> 0.1.1 (default)");
	console.error("  minor: 0.1.0 -> 0.2.0");
	console.error("  major: 0.1.0 -> 1.0.0");
	process.exit(1);
}

// Parse current version
const [major, minor, patch] = packageJson.version.split(".").map(Number);

// Calculate new version
let newVersion;
switch (bumpType) {
	case "major":
		newVersion = `${major + 1}.0.0`;
		break;
	case "minor":
		newVersion = `${major}.${minor + 1}.0`;
		break;
	case "patch":
	default:
		newVersion = `${major}.${minor}.${patch + 1}`;
		break;
}

// Update package.json
packageJson.version = newVersion;
fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, "\t") + "\n");
console.log(`Version bumped: ${packageJson.version} -> ${newVersion}`);

// Return the new version for use in scripts
process.stdout.write(`${packageJson.version} -> ${newVersion}`);
