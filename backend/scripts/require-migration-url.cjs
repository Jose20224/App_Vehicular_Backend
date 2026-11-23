const value = process.env.DATABASE_MIGRATION_URL;
if (!value) {
  console.error('Falta DATABASE_MIGRATION_URL. Las migraciones requieren la conexión directa de app_migrator.');
  process.exit(1);
}
try {
  const url = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('protocolo inválido');
  if (decodeURIComponent(url.username) !== 'app_migrator') throw new Error('el usuario no es app_migrator');
} catch (error) {
  console.error(`DATABASE_MIGRATION_URL inválida: ${error instanceof Error ? error.message : 'error desconocido'}`);
  process.exit(1);
}
