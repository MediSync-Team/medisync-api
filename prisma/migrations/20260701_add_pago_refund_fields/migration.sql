-- Reembolsos: campos de auditoría del reembolso de Mercado Pago en "pago".
-- Operación aditiva (columnas nullable): no reescribe la tabla ni toca filas existentes.
ALTER TABLE "pago" ADD COLUMN "mp_refund_id" TEXT;
ALTER TABLE "pago" ADD COLUMN "reembolsado_at" TIMESTAMP(3);
