const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { spawnSync } = require("child_process");
const dotenv = require("dotenv");

const envPath = path.resolve(process.cwd(), ".env.production");

if (!fs.existsSync(envPath)) {
  console.error("Missing .env.production");
  process.exit(1);
}

dotenv.config({ path: envPath });

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error("DATABASE_URL is missing in .env.production");
  process.exit(1);
}

if (
  databaseUrl.includes("localhost") ||
  databaseUrl.includes("127.0.0.1") ||
  databaseUrl.includes("postgres:postgres")
) {
  console.error("Refusing to run production db push against a local-looking DATABASE_URL.");
  process.exit(1);
}

if (!databaseUrl.includes("neon.tech")) {
  console.error("Refusing to run: production DATABASE_URL does not look like Neon.");
  process.exit(1);
}

const parsedUrl = new URL(databaseUrl);

console.log("");
console.log("WARNING: You are about to run Prisma db push against production.");
console.log(`Host: ${parsedUrl.hostname}`);
console.log(`Database: ${parsedUrl.pathname.replace("/", "")}`);
console.log("");
console.log("This should be temporary. Prefer prisma migrate deploy for production.");
console.log("");

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

rl.question('Type "PUSH PROD MEDISYNC" to continue: ', (answer) => {
  rl.close();

  if (answer !== "PUSH PROD MEDISYNC") {
    console.log("Cancelled.");
    process.exit(1);
  }

  const result = spawnSync("npx", ["prisma", "db", "push"], {
    stdio: "inherit",
    shell: true,
    env: process.env,
  });

  process.exit(result.status ?? 1);
});