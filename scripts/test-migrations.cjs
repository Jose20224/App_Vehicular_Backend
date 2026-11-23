/* eslint-disable no-console */
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { GenericContainer, Wait } = require('testcontainers');
const { Client } = require('pg');

const ROOT = path.resolve(__dirname, '..');
const ADMIN_PASSWORD = 'test-admin-password';
const MIGRATOR_PASSWORD = 'test-migrator-password';
const RUNTIME_PASSWORD = 'test-runtime-password';

async function createRolesAndExtensions(client) {
  await client.query(`CREATE ROLE app_migrator LOGIN PASSWORD '${MIGRATOR_PASSWORD}' NOSUPERUSER NOCREATEDB NOCREATEROLE`);
  await client.query(`CREATE ROLE app_runtime LOGIN PASSWORD '${RUNTIME_PASSWORD}' NOSUPERUSER NOCREATEDB NOCREATEROLE`);
  await client.query('GRANT CONNECT ON DATABASE vehicular_test TO app_migrator, app_runtime');
  await client.query('GRANT USAGE, CREATE ON SCHEMA public TO app_migrator');
  await client.query('GRANT USAGE ON SCHEMA public TO app_runtime');
  await client.query('CREATE EXTENSION IF NOT EXISTS postgis');
  await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
  await client.query(`ALTER DEFAULT PRIVILEGES FOR ROLE app_migrator IN SCHEMA public GRANT SELECT, INSERT, UPDATE ON TABLES TO app_runtime`);
}

async function main() {
  let container;
  let admin;
  let runtime;
  try {
    container = await new GenericContainer('postgis/postgis:16-3.5')
      .withEnvironment({
        POSTGRES_USER: 'postgres_admin',
        POSTGRES_PASSWORD: ADMIN_PASSWORD,
        POSTGRES_DB: 'vehicular_test',
      })
      .withExposedPorts(5432)
      // Ignore readiness from the temporary init server, which shuts down again.
      .withWaitStrategy(Wait.forLogMessage('database system is ready to accept connections', 2))
      .start();

    const host = container.getHost();
    const port = container.getMappedPort(5432);
    admin = new Client({ host, port, user: 'postgres_admin', password: ADMIN_PASSWORD, database: 'vehicular_test' });
    await admin.connect();
    await createRolesAndExtensions(admin);

    const migrationUrl = `postgresql://app_migrator:${MIGRATOR_PASSWORD}@${host}:${port}/vehicular_test?schema=public`;
    const runtimeUrl = `postgresql://app_runtime:${RUNTIME_PASSWORD}@${host}:${port}/vehicular_test?schema=public`;
    const cli = path.join(ROOT, 'node_modules', 'prisma', 'build', 'index.js');
    execFileSync(process.execPath, [cli, 'migrate', 'deploy'], {
      cwd: ROOT,
      stdio: 'inherit',
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DATABASE_MIGRATION_URL: migrationUrl,
      },
    });

    const checks = await admin.query(`
      SELECT
        EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='foundation_metadata') AS has_metadata,
        EXISTS (SELECT 1 FROM pg_class WHERE relname='sync_version_seq' AND relkind='S') AS has_sequence,
        EXISTS (SELECT 1 FROM pg_proc WHERE proname='assign_sync_metadata') AS has_trigger_function,
        EXISTS (SELECT 1 FROM pg_extension WHERE extname='postgis') AS has_postgis,
        EXISTS (SELECT 1 FROM pg_extension WHERE extname='pgcrypto') AS has_pgcrypto
    `);
    const state = checks.rows[0];
    if (!state.has_metadata || !state.has_sequence || !state.has_trigger_function || !state.has_postgis || !state.has_pgcrypto) {
      throw new Error('La migración no creó todos los objetos esperados.');
    }

    await admin.query(`
      CREATE TABLE public._test_sync_ready (
        id UUID PRIMARY KEY,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        deleted_at TIMESTAMPTZ NULL,
        sync_version BIGINT NOT NULL DEFAULT 0
      );
      CREATE TRIGGER trg_test_sync_metadata
      BEFORE INSERT OR UPDATE ON public._test_sync_ready
      FOR EACH ROW EXECUTE FUNCTION public.assign_sync_metadata();
      GRANT SELECT, INSERT, UPDATE ON public._test_sync_ready TO app_runtime;
    `);

    runtime = new Client({ host, port, user: 'app_runtime', password: RUNTIME_PASSWORD, database: 'vehicular_test' });
    await runtime.connect();
    const id = '0192f2a0-7d2a-7c11-9d5a-123456789abc';
    const inserted = await runtime.query(
      `INSERT INTO public._test_sync_ready (id, created_at, updated_at, sync_version)
       VALUES ($1, now(), now(), 999999) RETURNING sync_version, created_at, updated_at`,
      [id],
    );
    const insertVersion = BigInt(inserted.rows[0].sync_version);
    if (insertVersion === 999999n) throw new Error('El trigger aceptó un sync_version enviado por el cliente.');

    let sequenceAccessDenied = false;
    try {
      await runtime.query(`SELECT nextval('public.sync_version_seq')`);
    } catch (error) {
      sequenceAccessDenied = error && error.code === '42501';
    }
    if (!sequenceAccessDenied) throw new Error('app_runtime pudo consumir sync_version_seq directamente.');

    const updated = await runtime.query(
      `UPDATE public._test_sync_ready SET updated_at = '2000-01-01T00:00:00Z' WHERE id = $1 RETURNING sync_version, updated_at`,
      [id],
    );
    if (BigInt(updated.rows[0].sync_version) <= insertVersion) {
      throw new Error('sync_version no avanzó en la actualización.');
    }
    if (new Date(updated.rows[0].updated_at).getUTCFullYear() === 2000) {
      throw new Error('El trigger no reemplazó updated_at.');
    }
    const b1Tables = await admin.query(`
      SELECT
        to_regclass('public.users') IS NOT NULL AS users,
        to_regclass('public.refresh_tokens') IS NOT NULL AS refresh_tokens,
        to_regclass('public.device_tokens') IS NOT NULL AS device_tokens,
        to_regclass('public.consent_logs') IS NOT NULL AS consent_logs,
        to_regclass('public.sync_devices') IS NOT NULL AS sync_devices
    `);
    if (Object.values(b1Tables.rows[0]).some((exists) => exists !== true)) {
      throw new Error('La migración B1 no creó las cinco tablas de identidad esperadas.');
    }

    const userId = '0192f2a0-7d2a-7c11-9d5a-123456789ab1';
    const otherUserId = '0192f2a0-7d2a-7c11-9d5a-123456789ab2';
    const deviceId = '0192f2a0-7d2a-7c11-9d5a-123456789ab3';
    const otherDeviceId = '0192f2a0-7d2a-7c11-9d5a-123456789ab4';
    const consentId = '0192f2a0-7d2a-7c11-9d5a-123456789ab5';

    const insertUser = async (id, suffix) => runtime.query(`
      INSERT INTO public.users (
        id, phone_ciphertext, phone_nonce, phone_tag, phone_encrypted_dek,
        phone_key_version, phone_hmac, phone_hmac_key_version, display_name
      ) VALUES (
        $1, decode('01','hex'), decode(repeat('02',12),'hex'), decode(repeat('03',16),'hex'),
        decode('04','hex'), 'test-key', decode(repeat($2,32),'hex'), 'test-hmac-key', 'Usuario de prueba'
      )
    `, [id, suffix]);

    await insertUser(userId, '11');
    await insertUser(otherUserId, '22');
    await runtime.query(`
      INSERT INTO public.sync_devices (id, user_id, platform) VALUES
      ($1, $2, 'android'), ($3, $4, 'ios')
    `, [deviceId, userId, otherDeviceId, otherUserId]);

    const consentInserted = await runtime.query(`
      INSERT INTO public.consent_logs (
        id, user_id, consent_type, policy_version, accepted, source,
        ip_ciphertext, ip_nonce, ip_tag, ip_encrypted_dek, ip_key_version,
        user_agent_ciphertext, user_agent_nonce, user_agent_tag, user_agent_encrypted_dek, user_agent_key_version
      ) VALUES ($1, $2, 'privacy_policy', 'test-v1', true, 'mobile',
        decode('01','hex'), decode(repeat('02',12),'hex'), decode(repeat('03',16),'hex'), decode('04','hex'), 'test-key',
        decode('05','hex'), decode(repeat('06',12),'hex'), decode(repeat('07',16),'hex'), decode('08','hex'), 'test-key')
      RETURNING id, received_at, updated_at
    `, [consentId, userId]);
    if (!consentInserted.rows[0].id) throw new Error('ConsentLog no creó el registro de evidencia.');

    let partialConsentMetadataDenied = false;
    try {
      await runtime.query(`UPDATE public.consent_logs SET ip_ciphertext = NULL WHERE id = $1`, [consentId]);
    } catch (error) {
      partialConsentMetadataDenied = error && error.code === '23514';
    }
    if (!partialConsentMetadataDenied) throw new Error('ConsentLog permitió dejar metadata cifrada incompleta.');

    const anonymized = await runtime.query(`
      UPDATE public.consent_logs SET
        ip_ciphertext = NULL, ip_nonce = NULL, ip_tag = NULL, ip_encrypted_dek = NULL, ip_key_version = NULL,
        user_agent_ciphertext = NULL, user_agent_nonce = NULL, user_agent_tag = NULL,
        user_agent_encrypted_dek = NULL, user_agent_key_version = NULL
      WHERE id = $1 RETURNING ip_ciphertext, user_agent_ciphertext, accepted
    `, [consentId]);
    if (anonymized.rows[0].ip_ciphertext !== null || anonymized.rows[0].user_agent_ciphertext !== null || anonymized.rows[0].accepted !== true) {
      throw new Error('La anonimización de ConsentLog no conservó los datos de aceptación.');
    }

    let consentMutationDenied = false;
    try {
      await runtime.query(`UPDATE public.consent_logs SET accepted = false WHERE id = $1`, [consentId]);
    } catch (error) {
      consentMutationDenied = error && error.code === 'P0001';
    }
    if (!consentMutationDenied) throw new Error('ConsentLog permitió alterar la evidencia de aceptación.');

    let refreshOwnerDenied = false;
    try {
      await runtime.query(`
        INSERT INTO public.refresh_tokens (user_id, token_hash, family_id, device_id, expires_at)
        VALUES ($1, decode(repeat('33',32),'hex'), $2, $3, now() + interval '1 hour')
      `, [userId, '0192f2a0-7d2a-7c11-9d5a-123456789ab6', otherDeviceId]);
    } catch (error) {
      refreshOwnerDenied = error && error.code === 'P0001';
    }
    if (!refreshOwnerDenied) throw new Error('La BD permitió asociar un refresh token al dispositivo de otra cuenta.');

    let deviceTokenOwnerDenied = false;
    try {
      await runtime.query(`
        INSERT INTO public.device_tokens (
          user_id, sync_device_id, platform, token_ciphertext, token_nonce, token_tag,
          token_encrypted_dek, token_key_version, token_hash, token_hmac_key_version
        ) VALUES (
          $1, $2, 'android', decode('01','hex'), decode(repeat('02',12),'hex'),
          decode(repeat('03',16),'hex'), decode('04','hex'), 'test-key',
          decode(repeat('44',32),'hex'), 'test-hmac-key'
        )
      `, [userId, otherDeviceId]);
    } catch (error) {
      deviceTokenOwnerDenied = error && error.code === 'P0001';
    }
    if (!deviceTokenOwnerDenied) throw new Error('La BD permitió asociar un token FCM al dispositivo de otra cuenta.');

    const b2Tables = await admin.query(`
      SELECT
        to_regclass('public.vehicles') IS NOT NULL AS vehicles,
        to_regclass('public.vehicle_brands') IS NOT NULL AS vehicle_brands,
        to_regclass('public.vehicle_models') IS NOT NULL AS vehicle_models,
        to_regclass('public.catalog_versions') IS NOT NULL AS catalog_versions
    `);
    if (Object.values(b2Tables.rows[0]).some((exists) => exists !== true)) {
      throw new Error('La migración B2 no creó las tablas de vehículos y catálogos esperadas.');
    }

    const brandOne = '20000000-0000-4000-8000-000000000001';
    const brandTwo = '20000000-0000-4000-8000-000000000002';
    const modelOne = '30000000-0000-4000-8000-000000000001';
    const modelTwo = '30000000-0000-4000-8000-000000000002';
    await admin.query(`
      INSERT INTO public.vehicle_brands (id, name, normalized_name) VALUES
        ($1, 'Toyota', 'toyota'), ($2, 'Honda', 'honda')
    `, [brandOne, brandTwo]);
    await admin.query(`
      INSERT INTO public.vehicle_models (id, brand_id, name, normalized_name) VALUES
        ($1, $2, 'Corolla', 'corolla'), ($3, $4, 'Civic', 'civic')
    `, [modelOne, brandOne, modelTwo, brandTwo]);
    const catalogVersions = await admin.query(`
      SELECT catalog_name, version FROM public.catalog_versions
      WHERE catalog_name IN ('vehicle-brands', 'vehicle-models')
    `);
    if (catalogVersions.rows.length !== 2 || catalogVersions.rows.some((row) => BigInt(row.version) < 2n)) {
      throw new Error('Los triggers de catálogos no incrementaron sus versiones al insertar filas.');
    }

    const insertVehicle = async (id, plateHmac, brandId = brandOne, modelId = modelOne, modelYear = new Date().getUTCFullYear()) => runtime.query(`
      INSERT INTO public.vehicles (
        id, user_id, plate_ciphertext, plate_nonce, plate_tag, plate_encrypted_dek,
        plate_key_version, plate_hmac, plate_hmac_key_version, brand_id, brand_label,
        model_id, model_label, model_year, vehicle_type, sync_version
      ) VALUES (
        $1, $2, decode('01','hex'), decode(repeat('02',12),'hex'), decode(repeat('03',16),'hex'),
        decode('04','hex'), 'test-key', decode($3,'hex'), 'test-hmac-key', $4, 'Toyota',
        $5, 'Corolla', $6, 'automobile', 999999
      ) RETURNING sync_version, updated_at
    `, [id, userId, plateHmac, brandId, modelId, modelYear]);

    const vehicleOneId = '0192f2a0-7d2a-7c11-9d5a-123456789ab7';
    const vehicleTwoId = '0192f2a0-7d2a-7c11-9d5a-123456789ab8';
    const plateDigest = 'aa'.repeat(32);
    const vehicleInserted = await insertVehicle(vehicleOneId, plateDigest);
    const firstVehicleVersion = BigInt(vehicleInserted.rows[0].sync_version);
    if (firstVehicleVersion === 999999n || firstVehicleVersion < 1n) {
      throw new Error('El trigger B2 no asignó sync_version desde la secuencia global.');
    }
    const vehicleUpdated = await runtime.query(`
      UPDATE public.vehicles SET mileage_km = 1200 WHERE id = $1 RETURNING sync_version, updated_at
    `, [vehicleOneId]);
    if (BigInt(vehicleUpdated.rows[0].sync_version) <= firstVehicleVersion) {
      throw new Error('La actualización de vehículo no incrementó sync_version.');
    }

    let duplicateVehiclePlateDenied = false;
    try {
      await insertVehicle(vehicleTwoId, plateDigest);
    } catch (error) {
      duplicateVehiclePlateDenied = error && error.code === '23505';
    }
    if (!duplicateVehiclePlateDenied) throw new Error('La BD permitió placas duplicadas activas para el mismo usuario.');

    const tombstone = await runtime.query(`
      UPDATE public.vehicles SET deleted_at = now() WHERE id = $1 RETURNING sync_version
    `, [vehicleOneId]);
    if (BigInt(tombstone.rows[0].sync_version) <= BigInt(vehicleUpdated.rows[0].sync_version)) {
      throw new Error('El borrado lógico del vehículo no incrementó sync_version.');
    }
    const reusedPlate = await insertVehicle(vehicleTwoId, plateDigest);
    if (!reusedPlate.rows[0].sync_version) throw new Error('No se pudo reutilizar una placa tras borrar lógicamente el vehículo.');

    let mismatchedModelDenied = false;
    try {
      await insertVehicle('0192f2a0-7d2a-7c11-9d5a-123456789ab9', 'bb'.repeat(32), brandOne, modelTwo);
    } catch (error) {
      mismatchedModelDenied = error && error.code === '23503';
    }
    if (!mismatchedModelDenied) throw new Error('La BD permitió un modelo que pertenece a otra marca.');

    let outOfRangeYearDenied = false;
    const localYear = await admin.query(`
      SELECT EXTRACT(YEAR FROM (clock_timestamp() AT TIME ZONE 'America/Managua'))::INTEGER AS year
    `);
    try {
      await insertVehicle('0192f2a0-7d2a-7c11-9d5a-123456789aba', 'cc'.repeat(32), brandOne, modelOne, localYear.rows[0].year + 2);
    } catch (error) {
      outOfRangeYearDenied = error && error.code === '23514';
    }
    if (!outOfRangeYearDenied) throw new Error('La BD permitió un año de modelo superior al año actual más uno.');

    const b3Tables = await admin.query(`
      SELECT
        to_regclass('public.insurers') IS NOT NULL AS insurers,
        to_regclass('public.vehicle_documents') IS NOT NULL AS vehicle_documents,
        to_regclass('public.insurance_policies') IS NOT NULL AS insurance_policies,
        EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='vehicles' AND column_name='plate_aad_version') AS plate_aad_version
    `);
    if (Object.values(b3Tables.rows[0]).some((exists) => exists !== true)) {
      throw new Error('La migración B3 no creó las tablas de documentos y pólizas esperadas.');
    }
    const insurerId = '40000000-0000-4000-8000-000000000001';
    const policyId = '0192f2a0-7d2a-7c11-9d5a-123456789ac1';
    const documentId = '0192f2a0-7d2a-7c11-9d5a-123456789ac2';
    await admin.query(`INSERT INTO public.insurers (id, name, normalized_name) VALUES ($1, 'Aseguradora de prueba', 'aseguradora de prueba')`, [insurerId]);
    const insurerVersion = await admin.query(`SELECT version FROM public.catalog_versions WHERE catalog_name='insurers'`);
    if (BigInt(insurerVersion.rows[0].version) < 1n) throw new Error('El catálogo insurers no incrementó su ETag/version.');
    let insurerWriteDenied = false;
    try { await runtime.query(`UPDATE public.insurers SET name='Cambio no permitido' WHERE id=$1`, [insurerId]); }
    catch (error) { insurerWriteDenied = error && error.code === '42501'; }
    if (!insurerWriteDenied) throw new Error('app_runtime puede modificar el catálogo de aseguradoras de solo lectura.');

    const policyInsert = await runtime.query(`
      INSERT INTO public.insurance_policies (
        id, user_id, vehicle_id, insurer_id, policy_number_ciphertext, policy_number_nonce,
        policy_number_tag, policy_number_encrypted_dek, policy_number_key_version,
        policy_number_aad_version, valid_from, valid_until, deductible, currency, sync_version
      ) VALUES (
        $1, $2, $3, $4, decode('deadbeef','hex'), decode(repeat('02',12),'hex'),
        decode(repeat('03',16),'hex'), decode('04','hex'), 'test-kms-key', 2,
        DATE '2026-01-01', DATE '2026-12-31', 0, 'USD', 999999
      ) RETURNING sync_version
    `, [policyId, userId, vehicleTwoId, insurerId]);
    if (BigInt(policyInsert.rows[0].sync_version) === 999999n) throw new Error('InsurancePolicy no recibió sync_version del trigger.');
    const encryptedPolicy = await admin.query(`SELECT policy_number_ciphertext FROM public.insurance_policies WHERE id=$1`, [policyId]);
    if (encryptedPolicy.rows[0].policy_number_ciphertext.toString('hex') === Buffer.from('POL-SECRET-2026').toString('hex')) {
      throw new Error('El número de póliza quedó almacenado en texto claro.');
    }
    const documentInsert = await runtime.query(`
      INSERT INTO public.vehicle_documents (id, user_id, vehicle_id, document_type, title, valid_from, valid_until, file_status, sync_version)
      VALUES ($1, $2, $3, 'poliza', 'Póliza prueba', DATE '2026-01-01', DATE '2026-12-31', 'pendiente_subida', 999999)
      RETURNING sync_version, file_status
    `, [documentId, userId, vehicleTwoId]);
    if (BigInt(documentInsert.rows[0].sync_version) === 999999n || documentInsert.rows[0].file_status !== 'pendiente_subida') {
      throw new Error('VehicleDocument no recibió sync_version o no conservó pending_upload.');
    }
    await runtime.query(`UPDATE public.vehicle_documents SET insurance_policy_id=$1 WHERE id=$2`, [policyId, documentId]);
    let oversizedDocumentDenied = false;
    try {
      await runtime.query(`UPDATE public.vehicle_documents SET pending_object_key='staging/test', pending_content_type='application/pdf', pending_size_bytes=10485761, pending_url_issued_at=now() WHERE id=$1`, [documentId]);
    } catch (error) { oversizedDocumentDenied = error && error.code === '23514'; }
    if (!oversizedDocumentDenied) throw new Error('La BD permitió registrar un documento mayor de 10 MB.');

    const policyTwoId = '0192f2a0-7d2a-7c11-9d5a-123456789ac3';
    let duplicateActivePolicyDenied = false;
    try {
      await runtime.query(`INSERT INTO public.insurance_policies (
        id, user_id, vehicle_id, insurer_id, policy_number_ciphertext, policy_number_nonce,
        policy_number_tag, policy_number_encrypted_dek, policy_number_key_version,
        valid_from, valid_until, currency
      ) VALUES ($1,$2,$3,$4,decode('bead','hex'),decode(repeat('02',12),'hex'),decode(repeat('03',16),'hex'),decode('04','hex'),'test-kms-key',DATE '2027-01-01',DATE '2027-12-31','USD')`,
      [policyTwoId, userId, vehicleTwoId, insurerId]);
    } catch (error) { duplicateActivePolicyDenied = error && error.code === '23505'; }
    if (!duplicateActivePolicyDenied) throw new Error('La BD permitió dos pólizas activas simultáneas para un vehículo.');
    await runtime.query(`UPDATE public.insurance_policies SET status='archived', archived_at=now() WHERE id=$1`, [policyId]);
    await runtime.query(`INSERT INTO public.insurance_policies (
      id, user_id, vehicle_id, insurer_id, policy_number_ciphertext, policy_number_nonce,
      policy_number_tag, policy_number_encrypted_dek, policy_number_key_version,
      valid_from, valid_until, currency, previous_policy_id
    ) VALUES ($1,$2,$3,$4,decode('bead','hex'),decode(repeat('02',12),'hex'),decode(repeat('03',16),'hex'),decode('04','hex'),'test-kms-key',DATE '2027-01-01',DATE '2027-12-31','USD',$5)`,
    [policyTwoId, userId, vehicleTwoId, insurerId, policyId]);
    const historyCount = await runtime.query(`SELECT COUNT(*)::int AS count FROM public.insurance_policies WHERE vehicle_id=$1`, [vehicleTwoId]);
    if (historyCount.rows[0].count !== 2) throw new Error('La renovación no conservó la póliza anterior en el historial.');

    let invalidPolicyDatesDenied = false;
    try {
      await runtime.query(`UPDATE public.insurance_policies SET valid_until=valid_from WHERE id=$1`, [policyId]);
    } catch (error) { invalidPolicyDatesDenied = error && error.code === '23514'; }
    if (!invalidPolicyDatesDenied) throw new Error('La BD permitió vigencia_fin <= vigencia_inicio.');

    const b4Tables = await admin.query(`
      SELECT to_regclass('public.reminders') IS NOT NULL AS reminders,
        to_regclass('public.notification_preferences') IS NOT NULL AS notification_preferences,
        to_regclass('public.notification_logs') IS NOT NULL AS notification_logs
    `);
    if (Object.values(b4Tables.rows[0]).some((exists) => exists !== true)) {
      throw new Error('La migración B4 no creó las tablas de recordatorios y notificaciones.');
    }
    const b4Columns = await admin.query(`
      SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='device_tokens' AND column_name='token_aad_version') AS token_aad_version
    `);
    if (!b4Columns.rows[0].token_aad_version) throw new Error('B4 no agregó la versión AAD de tokens FCM.');

    const reminderId = '0192f2a0-7d2a-7c11-9d5a-123456789ad1';
    const preferenceId = '0192f2a0-7d2a-7c11-9d5a-123456789ad2';
    const reminderInsert = await runtime.query(`
      INSERT INTO public.reminders (id, user_id, vehicle_document_id, title, due_at, scheduled_at, lead_time_days)
      VALUES ($1, $2, $3, 'Vencimiento de prueba', now() + interval '31 days', now() + interval '1 day', 30)
      RETURNING sync_version
    `, [reminderId, userId, documentId]);
    if (BigInt(reminderInsert.rows[0].sync_version) <= 0n) throw new Error('Reminder no recibió sync_version del trigger.');
    await runtime.query(`
      INSERT INTO public.notification_preferences (id, user_id, enabled_offsets, preferred_time)
      VALUES ($1, $2, ARRAY[30,15,7,1,0]::INTEGER[], '09:00')
    `, [preferenceId, userId]);
    let invalidOffsetsDenied = false;
    try { await runtime.query(`UPDATE public.notification_preferences SET enabled_offsets=ARRAY[14]::INTEGER[] WHERE id=$1`, [preferenceId]); }
    catch (error) { invalidOffsetsDenied = error && error.code === '23514'; }
    if (!invalidOffsetsDenied) throw new Error('NotificationPreference aceptó un offset fuera del catálogo.');
    await runtime.query(`
      INSERT INTO public.notification_logs (user_id, reminder_id, channel, provider, status, sent_at)
      VALUES ($1, $2, 'push', 'fcm', 'sent', now())
    `, [userId, reminderId]);
    let notificationOwnerDenied = false;
    try {
      await runtime.query(`INSERT INTO public.notification_logs (user_id, reminder_id, channel, provider, status) VALUES ($1, $2, 'in_app', 'internal', 'sent')`, [otherUserId, reminderId]);
    } catch (error) { notificationOwnerDenied = error && error.code === '23503'; }
    if (!notificationOwnerDenied) throw new Error('NotificationLog permitió asociar un recordatorio de otro propietario.');

    const b5Tables = await admin.query(`
      SELECT to_regclass('public.emergency_contacts') IS NOT NULL AS emergency_contacts,
        to_regclass('public.emergency_numbers') IS NOT NULL AS emergency_numbers,
        to_regclass('public.departments') IS NOT NULL AS departments,
        to_regclass('public.municipalities') IS NOT NULL AS municipalities,
        to_regclass('public.service_types') IS NOT NULL AS service_types,
        to_regclass('public.specialties') IS NOT NULL AS specialties
    `);
    if (Object.values(b5Tables.rows[0]).some((exists) => exists !== true)) throw new Error('B5 no creó todas las tablas de catálogos y emergencias.');

    const departmentId = '50000000-0000-4000-8000-000000000001';
    const municipalityId = '50000000-0000-4000-8000-000000000002';
    await admin.query(`INSERT INTO public.departments (id, code, name, administrative_type) VALUES ($1, '55', 'Managua', 'department')`, [departmentId]);
    await admin.query(`INSERT INTO public.municipalities (id, department_id, code, name) VALUES ($1, $2, '55-managua', 'Managua')`, [municipalityId, departmentId]);

    const emergencyNumberId = '50000000-0000-4000-8000-000000000003';
    await runtime.query(`INSERT INTO public.emergency_numbers (id, label, category, phone_number, department_id, municipality_id, verified) VALUES ($1, 'Número aún no verificado', 'other', '1234', $2, $3, FALSE)`, [emergencyNumberId, departmentId, municipalityId]);
    const emergencyVersionBefore = await admin.query(`SELECT version FROM public.catalog_versions WHERE catalog_name='emergency-numbers'`);
    await runtime.query(`UPDATE public.emergency_numbers SET label='Número revisado' WHERE id=$1`, [emergencyNumberId]);
    const emergencyVersionAfter = await admin.query(`SELECT version FROM public.catalog_versions WHERE catalog_name='emergency-numbers'`);
    if (BigInt(emergencyVersionAfter.rows[0].version) <= BigInt(emergencyVersionBefore.rows[0].version)) {
      throw new Error('Editar un número de emergencia no incrementó la versión del catálogo.');
    }
    const unverified = await admin.query(`SELECT verified FROM public.emergency_numbers WHERE id=$1`, [emergencyNumberId]);
    if (unverified.rows[0].verified !== false) throw new Error('Un número no verificado se publicó como verificado.');
    await runtime.query(`UPDATE public.emergency_numbers SET verified=TRUE, source_name='Fuente oficial de prueba', verified_at=now(), verified_by_user_id=$2 WHERE id=$1`, [emergencyNumberId, userId]);
    await runtime.query(`UPDATE public.emergency_numbers SET phone_number='1235' WHERE id=$1`, [emergencyNumberId]);
    const revalidation = await admin.query(`SELECT verified, source_name, verified_at, verified_by_user_id FROM public.emergency_numbers WHERE id=$1`, [emergencyNumberId]);
    if (revalidation.rows[0].verified !== false
      || revalidation.rows[0].verified_at !== null || revalidation.rows[0].verified_by_user_id !== null) {
      throw new Error('Cambiar un número conservó indebidamente la verificación anterior.');
    }
    await runtime.query(`UPDATE public.emergency_numbers SET source_name='Fuente oficial de prueba', source_url='https://fuente.example/original' WHERE id=$1`, [emergencyNumberId]);
    await runtime.query(`UPDATE public.emergency_numbers SET verified=TRUE, verified_at=now(), verified_by_user_id=$2 WHERE id=$1`, [emergencyNumberId, userId]);
    await runtime.query(`UPDATE public.emergency_numbers SET source_url='https://fuente.example/actualizada' WHERE id=$1`, [emergencyNumberId]);
    const sourceRevalidation = await admin.query(`SELECT verified, verified_at, verified_by_user_id FROM public.emergency_numbers WHERE id=$1`, [emergencyNumberId]);
    if (sourceRevalidation.rows[0].verified !== false || sourceRevalidation.rows[0].verified_at !== null
      || sourceRevalidation.rows[0].verified_by_user_id !== null) {
      throw new Error('Cambiar la procedencia conservó indebidamente la verificación anterior.');
    }

    const emergencyContactIds = [
      '0192f2a0-7d2a-7c11-9d5a-123456789ae1', '0192f2a0-7d2a-7c11-9d5a-123456789ae2',
      '0192f2a0-7d2a-7c11-9d5a-123456789ae3', '0192f2a0-7d2a-7c11-9d5a-123456789ae4',
      '0192f2a0-7d2a-7c11-9d5a-123456789ae5', '0192f2a0-7d2a-7c11-9d5a-123456789ae6',
    ];
    const insertEmergencyContact = (id, isPrimary = false) => runtime.query(`
      INSERT INTO public.emergency_contacts (
        id, user_id, name, is_primary, phone_ciphertext, phone_nonce, phone_tag,
        phone_encrypted_dek, phone_key_version, phone_aad_version, phone_hmac, phone_hmac_key_version
      ) VALUES ($1, $2, 'Contacto de prueba', $3, decode('01','hex'), decode(repeat('02',12),'hex'),
        decode(repeat('03',16),'hex'), decode('04','hex'), 'test-key', 2, decode(repeat('44',32),'hex'), 'test-hmac')
    `, [id, userId, isPrimary]);
    for (let index = 0; index < 5; index += 1) await insertEmergencyContact(emergencyContactIds[index], index === 0);
    let sixthContactDenied = false;
    try { await insertEmergencyContact(emergencyContactIds[5]); }
    catch (error) { sixthContactDenied = error && error.code === '23514'; }
    if (!sixthContactDenied) throw new Error('La BD permitió el sexto contacto de emergencia activo.');
    await runtime.query(`UPDATE public.emergency_contacts SET deleted_at=now(), phone_ciphertext=NULL, phone_nonce=NULL, phone_tag=NULL, phone_encrypted_dek=NULL, phone_key_version=NULL, phone_aad_version=NULL, phone_hmac=NULL, phone_hmac_key_version=NULL WHERE id=$1`, [emergencyContactIds[0]]);
    await insertEmergencyContact(emergencyContactIds[5]);

    await runtime.end();
    runtime = undefined;

    const b51RollbackSql = require('node:fs').readFileSync(
      path.join(ROOT, 'prisma/migrations/20261104160000_emergency_verification_hardening/rollback.sql'), 'utf8',
    );
    await admin.query(b51RollbackSql);

    const b5RollbackSql = require('node:fs').readFileSync(
      path.join(ROOT, 'prisma/migrations/20261104150000_emergency_catalogs/rollback.sql'), 'utf8',
    );
    await admin.query(b5RollbackSql);
    const b5AfterRollback = await admin.query(`
      SELECT to_regclass('public.emergency_contacts') IS NULL AS contacts,
        to_regclass('public.emergency_numbers') IS NULL AS numbers,
        to_regclass('public.departments') IS NULL AS departments,
        to_regclass('public.municipalities') IS NULL AS municipalities,
        to_regclass('public.service_types') IS NULL AS services,
        to_regclass('public.specialties') IS NULL AS specialties
    `);
    if (Object.values(b5AfterRollback.rows[0]).some((exists) => exists !== true)) throw new Error('La reversa B5 no retiró las tablas de catálogos y emergencias.');

    const b4RollbackSql = require('node:fs').readFileSync(
      path.join(ROOT, 'prisma/migrations/20261104130000_reminders_notifications/rollback.sql'), 'utf8',
    );
    await admin.query(b4RollbackSql);
    const b4AfterRollback = await admin.query(`
      SELECT to_regclass('public.reminders') IS NULL AS reminders,
        to_regclass('public.notification_preferences') IS NULL AS preferences,
        to_regclass('public.notification_logs') IS NULL AS logs,
        NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='device_tokens' AND column_name='token_aad_version') AS aad_column_removed
    `);
    if (Object.values(b4AfterRollback.rows[0]).some((exists) => exists !== true)) throw new Error('La reversa B4 no retiró las tablas y columnas nuevas.');

    const b3RollbackSql = require('node:fs').readFileSync(
      path.join(ROOT, 'prisma/migrations/20261104100000_documents_policies/rollback.sql'), 'utf8',
    );
    await admin.query(b3RollbackSql);
    const b3AfterRollback = await admin.query(`
      SELECT to_regclass('public.insurers') IS NULL AS insurers,
        to_regclass('public.vehicle_documents') IS NULL AS vehicle_documents,
        to_regclass('public.insurance_policies') IS NULL AS insurance_policies,
        NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='vehicles' AND column_name='plate_aad_version') AS aad_columns_removed
    `);
    if (Object.values(b3AfterRollback.rows[0]).some((exists) => exists !== true)) {
      throw new Error('La reversa B3 no retiró las tablas de documentos y pólizas.');
    }

    const b2RollbackSql = require('node:fs').readFileSync(
      path.join(ROOT, 'prisma/migrations/20261103130000_vehicles/rollback.sql'),
      'utf8',
    );
    await admin.query(b2RollbackSql);
    const b2AfterRollback = await admin.query(`
      SELECT
        to_regclass('public.vehicles') IS NULL AS vehicles,
        to_regclass('public.vehicle_brands') IS NULL AS vehicle_brands,
        to_regclass('public.vehicle_models') IS NULL AS vehicle_models,
        to_regclass('public.catalog_versions') IS NULL AS catalog_versions
    `);
    if (Object.values(b2AfterRollback.rows[0]).some((exists) => exists !== true)) {
      throw new Error('La reversa B2 no retiró las tablas de vehículos y catálogos.');
    }

    await admin.query('DROP TABLE public._test_sync_ready');
    const b1RollbackSql = require('node:fs').readFileSync(
      path.join(ROOT, 'prisma/migrations/20261103110000_auth_users/rollback.sql'),
      'utf8',
    );
    await admin.query(b1RollbackSql);
    const b1AfterRollback = await admin.query(`
      SELECT
        to_regclass('public.users') IS NULL AS users,
        to_regclass('public.refresh_tokens') IS NULL AS refresh_tokens,
        to_regclass('public.device_tokens') IS NULL AS device_tokens,
        to_regclass('public.consent_logs') IS NULL AS consent_logs,
        to_regclass('public.sync_devices') IS NULL AS sync_devices
    `);
    if (Object.values(b1AfterRollback.rows[0]).some((exists) => exists !== true)) {
      throw new Error('La reversa B1 no retiró todas las tablas de identidad.');
    }

    const rollbackSql = require('node:fs').readFileSync(
      path.join(ROOT, 'prisma/migrations/20261103090000_foundation/rollback.sql'),
      'utf8',
    );
    await admin.query(rollbackSql);
    const afterRollback = await admin.query(`
      SELECT
        EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='foundation_metadata') AS has_metadata,
        EXISTS (SELECT 1 FROM pg_class WHERE relname='sync_version_seq' AND relkind='S') AS has_sequence,
        EXISTS (SELECT 1 FROM pg_proc WHERE proname='assign_sync_metadata') AS has_trigger_function
    `);
    if (afterRollback.rows[0].has_metadata || afterRollback.rows[0].has_sequence || afterRollback.rows[0].has_trigger_function) {
      throw new Error('La reversa no eliminó los objetos propios de la migración.');
    }

    console.log('Migraciones B0/B1/B2/B3/B4/B5/B5.1 y reversas verificadas; sync_version, catálogos, documentos, pólizas, recordatorios, notificaciones, contactos y emergencia comprobados.');
  } catch (error) {
    console.error('Falló la prueba de migraciones reversibles.', error);
    process.exitCode = 1;
  } finally {
    if (runtime) await runtime.end().catch(() => undefined);
    if (admin) await admin.end().catch(() => undefined);
    if (container) await container.stop().catch(() => undefined);
  }
}

void main();
