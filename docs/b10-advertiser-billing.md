# FASE B10: Cobro B2B y facturación a anunciantes

El cobro inicial se procesa por transferencia bancaria manual. Los pagos se conservan en USD; el equivalente en NIO se guarda como referencia informativa. La numeración de factura es correlativa y el formato fiscal permanece marcado como pendiente de confirmar con la normativa de la DGI.

## Flujo

1. El anunciante crea y envía una campaña a `pending_payment` (B9), y solicita `POST /ads/campaigns/:id/payment-orders`.
2. Recibe las instrucciones de transferencia, solicita una URL de carga en `POST /ads/payments/:id/proof-upload-url`, carga el archivo directamente a S3 y confirma con `POST /ads/payments/:id/proofs/:proofId/complete` incluyendo la referencia bancaria.
3. Un administrador revisa `GET /ads/admin/payments` y aprueba o rechaza. La aprobación marca el pago confirmado, activa la campaña si su fecha ya comenzó (o la deja programada en `pending_payment`) y crea la factura en una transacción. El rechazo devuelve la campaña a `pending_payment` y registra el motivo.
4. Las rutas `GET /ads/admin/payments/reconciliation`, `GET /ads/admin/exports/payments.csv` y `GET /ads/admin/exports/invoices.csv` permiten conciliación y exportación. Todos los endpoints de pagos requieren `workshop_owner`, `provider_owner` o `admin`; las rutas administrativas requieren `admin`.

Las referencias se normalizan y se guardan con un hash único, para rechazar una referencia ya usada. Los comprobantes privados tienen URLs firmadas y se verifican contra tamaño, tipo y firma del contenido. El job diario de anuncios también crea recordatorios en la bandeja interna para pagos pendientes y vencidos.

## Adaptadores

`PaymentGateway` define el contrato de instrucciones y `ManualTransferGateway` implementa el flujo actual. La conciliación, carga de comprobantes, revisión, factura y auditoría dependen del contrato y del estado del pago, de modo que una futura pasarela bancaria puede sustituir el adaptador.

## Migración

Aplicar `20261117100000_b10_advertiser_billing` después de la migración B9 y generar el cliente Prisma. La secuencia `ad_invoice_number_seq` genera folios `FAC-AAAA-########`.
