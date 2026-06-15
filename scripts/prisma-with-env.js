const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const dotenv = require("dotenv");

const [, , envFile, ...prismaArgs] = process.argv;

if (!envFile || prismaArgs.length === 0) {
  console.error("Usage: node scripts/prisma-with-env.js <env-file> <prisma args...>");
  process.exit(1);
}

const envPath = path.resolve(process.cwd(), envFile);

if (!fs.existsSync(envPath)) {
  console.error(`Env file not found: ${envPath}`);
  process.exit(1);
}

dotenv.config({ path: envPath });

if (!process.env.DATABASE_URL) {
  console.error(`DATABASE_URL is missing in ${envFile}`);
  process.exit(1);
}

const result = spawnSync("npx", ["prisma", ...prismaArgs], {
  stdio: "inherit",
  shell: true,
  env: process.env,
});

process.exit(result.status ?? 1);