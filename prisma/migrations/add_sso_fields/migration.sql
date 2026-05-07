-- AlterTable
ALTER TABLE "usuarios" ALTER COLUMN "password_hash" DROP NOT NULL;
ALTER TABLE "usuarios" ADD COLUMN "provider" TEXT;
ALTER TABLE "usuarios" ADD COLUMN "provider_account_id" TEXT;
