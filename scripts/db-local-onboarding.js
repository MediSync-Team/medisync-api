const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const envPath = path.resolve(process.cwd(), ".env.development");
const examplePath = path.resolve(process.cwd(), ".env.development.example");

function run(command, args) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: true,
    env: process.env,
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

if (!fs.existsSync(envPath)) {
  if (!fs.existsSync(examplePath)) {
    console.error("Missing .env.development.example");
    process.exit(1);
  }

  fs.copyFileSync(examplePath, envPath);
  console.log("Created .env.development from .env.development.example");
  console.log("Review .env.development before using real local services.");
}

console.log("");
console.log("Generating Prisma client...");
run("npx", ["prisma", "generate"]);

console.log("");
console.log("Pushing schema to local database...");
run("node", ["scripts/prisma-with-env.js", ".env.development", "db", "push"]);

console.log("");
console.log("Seeding local database...");
run("npm", ["run", "seed"]);

console.log("");
console.log("Local DB onboarding complete.");
console.log("Start the API with: npm run dev");