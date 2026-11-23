import { prismaBytes } from "../../database/prisma-bytes";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  HttpException,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
  ServiceUnavailableException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { Prisma, type VehicleDocumentType, type VehicleType } from '../../generated/prisma/client';
import { AppConfigService } from '../../config/config.module';
import { PrismaService } from '../../database/prisma.service';
import { isUuidV7 } from '../../common/uuid-v7';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { FieldCryptoService } from '../../security/field-crypto.service';
import { RemindersService } from '../reminders/reminders.service';
import { AssistanceQueueService } from '../providers/assistance-queue.service';
import { AssistanceRateLimitService } from '../providers/assistance-rate-limit.service';
import type { SyncBootstrapQueryDto, SyncPullQueryDto, SyncStatusQueryDto } from './dto/sync-query.dto';
import type { PushSyncDto, SyncMutationDto } from './dto/push-sync.dto';
import type { SyncChannel } from './dto/sync-query.dto';

type JsonObject = Record<string, unknown>;
type SyncEntity = 'profile' | 'vehicle' | 'vehicle_document' | 'insurance_policy' | 'notification_preference' | 'emergency_contact' | 'assistance_request' | 'reminder';
type UserRow = Prisma.UserGetPayload<Prisma.UserDefaultArgs>;
type VehicleRow = Prisma.VehicleGetPayload<Prisma.VehicleDefaultArgs>;
type VehicleDocumentRow = Prisma.VehicleDocumentGetPayload<Prisma.VehicleDocumentDefaultArgs>;
type InsurancePolicyRow = Prisma.InsurancePolicyGetPayload<Prisma.InsurancePolicyDefaultArgs> & Partial<{
  insurer: Prisma.InsurerGetPayload<Prisma.InsurerDefaultArgs> | null;
  document: VehicleDocumentRow | null;
}>;
type NotificationPreferenceRow = Prisma.NotificationPreferenceGetPayload<Prisma.NotificationPreferenceDefaultArgs>;
type EmergencyContactRow = Prisma.EmergencyContactGetPayload<Prisma.EmergencyContactDefaultArgs>;
type AssistanceRequestRow = Prisma.AssistanceRequestGetPayload<Prisma.AssistanceRequestDefaultArgs>;
type ReminderRow = Prisma.ReminderGetPayload<Prisma.ReminderDefaultArgs>;
type SyncEntityRow = UserRow | VehicleRow | VehicleDocumentRow | InsurancePolicyRow | NotificationPreferenceRow | EmergencyContactRow | AssistanceRequestRow | ReminderRow;
type ProcessedMutationRow = Prisma.ProcessedMutationGetPayload<Prisma.ProcessedMutationDefaultArgs>;
type VehicleVinFields = Partial<Pick<Prisma.VehicleUncheckedCreateInput, 'vinCiphertext' | 'vinNonce' | 'vinTag' | 'vinEncryptedDek' | 'vinKeyVersion' | 'vinAadVersion' | 'vinHmac' | 'vinHmacKeyVersion'>>;
type PolicyNumberFields = Partial<Pick<Prisma.InsurancePolicyUncheckedCreateInput, 'policyNumberCiphertext' | 'policyNumberNonce' | 'policyNumberTag' | 'policyNumberEncryptedDek' | 'policyNumberKeyVersion' | 'policyNumberAadVersion'>>;
type PolicyClaimsPhoneFields = Partial<Pick<Prisma.InsurancePolicyUncheckedCreateInput, 'claimsPhoneCiphertext' | 'claimsPhoneNonce' | 'claimsPhoneTag' | 'claimsPhoneEncryptedDek' | 'claimsPhoneKeyVersion' | 'claimsPhoneAadVersion'>>;
type EmergencyContactPhoneFields = Partial<Pick<Prisma.EmergencyContactUncheckedCreateInput, 'phoneCiphertext' | 'phoneNonce' | 'phoneTag' | 'phoneEncryptedDek' | 'phoneKeyVersion' | 'phoneAadVersion' | 'phoneHmac' | 'phoneHmacKeyVersion'>>;
type AssistanceRequestPhoneFields = Partial<Pick<Prisma.AssistanceRequestUncheckedCreateInput, 'contactPhoneCiphertext' | 'contactPhoneNonce' | 'contactPhoneTag' | 'contactPhoneEncryptedDek' | 'contactPhoneKeyVersion' | 'contactPhoneAadVersion' | 'contactPhoneHmac' | 'contactPhoneHmacKeyVersion'>>;
type MutationResult = {
  mutation_id: string; entity: string; id: string; status: 'applied' | 'conflict' | 'rejected';
  server_sync_version?: string | null; server_updated_at?: string | null;
  conflict_resolution?: string | null; reason?: string | null; details?: Record<string, unknown>;
  server_data?: Record<string, unknown> | null;
};
type CursorPayload = {
  v: 1; kind: 'ready' | 'scan'; userId: string; deviceId: string; channel: SyncChannel;
  ack: string; floor?: string; watermark?: string; afterVersion?: string; afterEntity?: string; afterId?: string; exp: number;
};
type BootstrapTokenPayload = { v: 1; kind: 'bootstrap'; userId: string; deviceId: string; bootstrapId: string; entityIndex: number; afterId: string | null; exp: number };

const CHANNEL_TO_ENTITIES: Record<SyncChannel, SyncEntity[]> = {
  all: ['profile', 'vehicle', 'vehicle_document', 'insurance_policy', 'notification_preference', 'emergency_contact', 'assistance_request', 'reminder'],
  profile: ['profile'],
  vehicles: ['vehicle'],
  documents: ['vehicle_document'],
  policies: ['insurance_policy'],
  notification_preferences: ['notification_preference'],
  emergency_contacts: ['emergency_contact'],
  assistance_requests: ['assistance_request'],
  reminders: ['reminder'],
};
const BOOTSTRAP_ENTITIES: SyncEntity[] = [
  'profile', 'vehicle', 'vehicle_document', 'insurance_policy', 'notification_preference',
  'emergency_contact', 'assistance_request', 'reminder',
];
const ENTITY_DATA_KEY: Record<SyncEntity, string> = {
  profile: 'profile', vehicle: 'vehicles', vehicle_document: 'vehicle_documents',
  insurance_policy: 'insurance_policies', notification_preference: 'notification_preferences',
  emergency_contact: 'emergency_contacts', assistance_request: 'assistance_requests', reminder: 'reminders',
};
const OVERLAP_VERSIONS = 5_000n;
const CURSOR_VALIDITY_DAYS = 90;
const IDEMPOTENCY_RETENTION_DAYS = 180;
const BOOTSTRAP_TTL_MS = 24 * 60 * 60 * 1000;
const CURSOR_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_BATCH_MUTATIONS = 50;
const MAX_MUTATION_BYTES = 256 * 1024;
const MAX_BATCH_BYTES = MAX_BATCH_MUTATIONS * MAX_MUTATION_BYTES;
const ALLOWED_VEHICLE_TYPES = new Set(['motorcycle', 'automobile', 'pickup', 'truck', 'bus', 'other']);
const ALLOWED_DOCUMENT_TYPES = new Set(['poliza', 'circulacion', 'revision', 'licencia', 'otro']);
const ALLOWED_OFFSETS = new Set([30, 15, 7, 1, 0]);
const ACTIVE_ASSISTANCE_STATES = ['created', 'sent', 'accepted', 'en_camino'];

@Injectable()
export class SyncService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: FieldCryptoService,
    private readonly reminders: RemindersService,
    private readonly config: AppConfigService,
    private readonly assistanceQueue: AssistanceQueueService,
    private readonly assistanceRateLimit: AssistanceRateLimitService,
  ) {}

  async status(user: AuthenticatedUser, query: SyncStatusQueryDto): Promise<Record<string, unknown>> {
    await this.assertDevice(user, query.device_id);
    const [device, channelStates, minimumCursor, currentVersion] = await Promise.all([
      this.prisma.syncDevice.findFirstOrThrow({ where: { id: query.device_id, userId: user.id } }),
      this.prisma.syncChannelState.findMany({ where: { userId: user.id, deviceId: query.device_id } }),
      this.minimumValidCursor(),
      this.maxVisibleSyncVersion(user.id),
    ]);
    if (query.platform && query.platform !== device.platform) {
      throw new BadRequestException({ code: 'DEVICE_PLATFORM_MISMATCH', message: 'La plataforma no coincide con el dispositivo registrado.', details: {} });
    }
    const stateByChannel = new Map(channelStates.map((state) => [state.channel, state]));
    const isExpired = (lastPulledAt: Date | null): boolean =>
      lastPulledAt !== null && Date.now() - lastPulledAt.getTime() > CURSOR_TTL_MS;
    const cursors = Object.fromEntries(Object.keys(CHANNEL_TO_ENTITIES).map((channel) => {
      const state = stateByChannel.get(channel);
      return [channel, {
        acknowledged_cursor: state?.acknowledgedCursor.toString() ?? '0',
        last_pulled_at: state?.lastPulledAt?.toISOString() ?? null,
        requires_resync: Boolean(state && (state.acknowledgedCursor < minimumCursor || isExpired(state.lastPulledAt))),
      }];
    }));
    const hasAnyCursor = channelStates.length > 0 || device.lastCursor !== null;
    const resyncRequired = channelStates.some((state) => state.acknowledgedCursor < minimumCursor || isExpired(state.lastPulledAt))
      || (channelStates.length === 0 && device.lastCursor !== null && device.lastCursor < minimumCursor);
    await this.prisma.syncDevice.update({ where: { id: query.device_id }, data: { lastSeenAt: new Date(), clientVersion: query.client_version ?? undefined } });
    return {
      protocol_version: 1,
      supported: true,
      device_id: query.device_id,
      platform: device.platform,
      client_version: query.client_version ?? device.clientVersion,
      server_time: new Date().toISOString(),
      current_sync_version: currentVersion.toString(),
      minimum_valid_cursor: minimumCursor.toString(),
      has_local_cursor: hasAnyCursor,
      resync_required: resyncRequired,
      max_page_size: 50,
      max_mutations_per_batch: MAX_BATCH_MUTATIONS,
      max_mutation_bytes: MAX_MUTATION_BYTES,
      max_batch_bytes: MAX_BATCH_BYTES,
      cursor_validity_days: CURSOR_VALIDITY_DAYS,
      idempotency_retention_days: IDEMPOTENCY_RETENTION_DAYS,
      overlap_window_versions: OVERLAP_VERSIONS.toString(),
      bootstrap_ttl_hours: 24,
      channels: Object.keys(CHANNEL_TO_ENTITIES),
      channel_manifest: Object.fromEntries(Object.entries(CHANNEL_TO_ENTITIES).map(([name, entities]) => [name, [...entities]])),
      channel_cursors: cursors,
      catalogs_endpoint: '/api/v1/catalogs/{name}',
      read_only_endpoints: ['/api/v1/reminders/schedule', '/api/v1/notifications'],
      excluded_from_push: [
        'reminder', 'notification_log', 'insurer', 'emergency_number', 'service_type', 'specialty',
        'department', 'municipality', 'vehicle_brand', 'vehicle_model', 'workshop', 'workshop_specialty',
        'workshop_photo', 'service_offering', 'assistance_provider', 'review', 'review_reply',
        'ad_plan', 'ad_slot', 'ad_campaign', 'ad_metric', 'payment', 'invoice', 'payment_proof',
        'audit_log', 'admin_audit_log', 'business_claim', 'refresh_token', 'device_token', 'sync_device', 'processed_mutation',
        'exchange_rate', 'consent_log',
      ],
    };
  }

  async bootstrap(user: AuthenticatedUser, query: SyncBootstrapQueryDto): Promise<Record<string, unknown>> {
    await this.assertDevice(user, query.device_id);
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 50);
    let bootstrapId: string;
    let snapshot: bigint;
    let entityIndex = 0;
    let afterId: string | null = null;

    if (query.page_token) {
      const token = this.readSignedToken<BootstrapTokenPayload>(query.page_token, 'BOOTSTRAP_TOKEN_INVALID');
      if (token.kind !== 'bootstrap' || token.userId !== user.id || token.deviceId !== query.device_id || token.entityIndex < 0 || token.entityIndex >= BOOTSTRAP_ENTITIES.length) {
        throw this.bootstrapTokenInvalid();
      }
      const session = await this.prisma.syncBootstrap.findFirst({ where: { id: token.bootstrapId, userId: user.id, deviceId: query.device_id } });
      if (!session) throw new GoneException({ code: 'BOOTSTRAP_EXPIRED', message: 'La instantánea expiró. Inicia un bootstrap nuevo.', details: {} });
      if (session.expiresAt <= new Date() || token.exp <= Date.now()) {
        await this.prisma.syncBootstrap.deleteMany({ where: { id: session.id, userId: user.id } });
        throw new GoneException({ code: 'BOOTSTRAP_EXPIRED', message: 'La instantánea expiró. Inicia un bootstrap nuevo.', details: {} });
      }
      bootstrapId = session.id;
      snapshot = session.snapshotSyncVersion;
      entityIndex = token.entityIndex;
      afterId = token.afterId;
    } else {
      // Un dispositivo mantiene una sola instantánea activa. Reiniciar bootstrap
      // invalida cualquier página previa del mismo dispositivo y evita acumular
      // sesiones abandonadas durante reinicios/reintentos de la app.
      await this.prisma.syncBootstrap.deleteMany({ where: { userId: user.id, deviceId: query.device_id } });
      snapshot = await this.maxVisibleSyncVersion(user.id);
      const session = await this.prisma.syncBootstrap.create({ data: {
        userId: user.id, deviceId: query.device_id, snapshotSyncVersion: snapshot,
        expiresAt: new Date(Date.now() + BOOTSTRAP_TTL_MS),
      } });
      bootstrapId = session.id;
    }

    const data: Record<string, unknown[]> = {
      profile: [], vehicles: [], vehicle_documents: [], insurance_policies: [],
      notification_preferences: [], emergency_contacts: [], assistance_requests: [], reminders: [],
    };
    let remaining = limit;
    let nextEntityIndex = entityIndex;
    let nextAfterId = afterId;
    let hasMore = false;

    while (nextEntityIndex < BOOTSTRAP_ENTITIES.length && remaining > 0) {
      const entity = BOOTSTRAP_ENTITIES[nextEntityIndex];
      const rows = await this.loadBootstrapRows(user.id, entity, snapshot, nextAfterId, remaining + 1);
      if (rows.length > remaining) {
        const selected = rows.slice(0, remaining);
        const serialized = await Promise.all(selected.map((row) => this.serializeEntity(entity, row, this.prisma)));
        data[ENTITY_DATA_KEY[entity]].push(...serialized);
        nextAfterId = selected[selected.length - 1]?.id ?? nextAfterId;
        hasMore = true;
        break;
      }
      const serialized = await Promise.all(rows.map((row) => this.serializeEntity(entity, row, this.prisma)));
      data[ENTITY_DATA_KEY[entity]].push(...serialized);
      remaining -= rows.length;
      nextEntityIndex += 1;
      nextAfterId = null;
    }

    if (!hasMore && nextEntityIndex < BOOTSTRAP_ENTITIES.length) {
      // La página quedó exactamente llena al terminar una entidad. El token
      // continúa con la siguiente sin repetir ni saltar el último elemento.
      hasMore = true;
    }

    const nextPageToken = hasMore ? this.signToken<BootstrapTokenPayload>({
      v: 1, kind: 'bootstrap', userId: user.id, deviceId: query.device_id,
      bootstrapId, entityIndex: nextEntityIndex, afterId: nextAfterId,
      exp: Date.now() + BOOTSTRAP_TTL_MS,
    }) : null;
    if (!hasMore) {
      await this.prisma.syncBootstrap.deleteMany({ where: { id: bootstrapId, userId: user.id, deviceId: query.device_id } });
    }

    return {
      bootstrap_id: bootstrapId,
      snapshot_sync_version: snapshot.toString(),
      initial_cursor: this.signToken<CursorPayload>({
        v: 1, kind: 'ready', userId: user.id, deviceId: query.device_id, channel: 'all',
        ack: snapshot.toString(), exp: Date.now() + CURSOR_TTL_MS,
      }),
      initial_cursors: Object.fromEntries(Object.keys(CHANNEL_TO_ENTITIES).map((channel) => [channel,
        this.signToken<CursorPayload>({
          v: 1, kind: 'ready', userId: user.id, deviceId: query.device_id, channel: channel as SyncChannel,
          ack: snapshot.toString(), exp: Date.now() + CURSOR_TTL_MS,
        }),
      ])),
      data,
      next_page_token: nextPageToken,
      has_more: hasMore,
      server_time: new Date().toISOString(),
    };
  }

  async pull(user: AuthenticatedUser, query: SyncPullQueryDto): Promise<Record<string, unknown>> {
    await this.assertDevice(user, query.device_id);
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 50);
    const channel = query.channel ?? 'all';
    let floor: bigint;
    let watermark: bigint;
    let afterVersion: bigint | null = null;
    let afterEntity: string | null = null;
    let afterId: string | null = null;
    const minimumCursor = await this.minimumValidCursor();
    const priorChannelState = await this.prisma.syncChannelState.findUnique({ where: { deviceId_channel: { deviceId: query.device_id, channel } } });
    if (priorChannelState?.lastPulledAt && Date.now() - priorChannelState.lastPulledAt.getTime() > CURSOR_TTL_MS) {
      throw this.resyncRequired();
    }

    // El cursor siempre es opaco y firmado. Aceptar un BIGINT enviado libremente
    // permitiría saltar cambios por error de cliente; snapshot_sync_version es solo informativo.
    const token = this.readSignedToken<CursorPayload>(query.cursor, 'INVALID_CURSOR');
    if (token.v !== 1 || (token.kind !== 'ready' && token.kind !== 'scan')) throw this.invalidCursor();
    if (token.userId !== user.id || token.deviceId !== query.device_id || token.channel !== channel) throw this.invalidCursor();
    if (!this.isValidVersionString(token.ack)) throw this.invalidCursor();
    const ack = BigInt(token.ack);
    if (ack < minimumCursor) throw this.resyncRequired();
    if (token.kind === 'ready') {
      await this.acknowledgeCursor(user.id, query.device_id, channel, ack);
      const visible = await this.maxVisibleSyncVersion(user.id);
      watermark = visible > ack ? visible : ack;
      floor = this.overlapFloor(ack, minimumCursor);
    } else {
      if (!this.isValidVersionString(token.floor) || !this.isValidVersionString(token.watermark)
        || !this.isValidVersionString(token.afterVersion) || !token.afterEntity || !token.afterId
        || !CHANNEL_TO_ENTITIES[channel].includes(token.afterEntity as SyncEntity)
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(token.afterId)) throw this.resyncRequired();
      floor = BigInt(token.floor);
      watermark = BigInt(token.watermark);
      afterVersion = BigInt(token.afterVersion);
      afterEntity = token.afterEntity;
      afterId = token.afterId;
      if (floor < minimumCursor || watermark < ack || afterVersion > watermark) throw this.resyncRequired();
    }

    const entities = CHANNEL_TO_ENTITIES[channel];
    const rawChanges = await this.loadPullChanges(user.id, entities, floor, watermark, afterVersion, afterEntity, afterId, limit + 1);
    const hasMore = rawChanges.length > limit;
    const selected = hasMore ? rawChanges.slice(0, limit) : rawChanges;
    const changes = await Promise.all(selected.map(async (change) => {
      const data = change.deletedAt ? null : await this.serializeEntity(change.entity, change.row, this.prisma);
      return {
        entity: change.entity,
        operation: change.deletedAt ? 'delete' : 'upsert',
        id: change.id,
        data,
        deleted_at: change.deletedAt?.toISOString() ?? null,
        sync_version: change.syncVersion.toString(),
      };
    }));

    let nextCursor: string;
    if (hasMore && selected.length > 0) {
      const last = selected[selected.length - 1];
      nextCursor = this.signToken<CursorPayload>({
        v: 1, kind: 'scan', userId: user.id, deviceId: query.device_id, channel,
        ack: ack.toString(), floor: floor.toString(), watermark: watermark.toString(),
        afterVersion: last.syncVersion.toString(), afterEntity: last.entity, afterId: last.id,
        exp: Date.now() + CURSOR_TTL_MS,
      });
    } else {
      nextCursor = this.signToken<CursorPayload>({
        v: 1, kind: 'ready', userId: user.id, deviceId: query.device_id, channel,
        ack: watermark.toString(), exp: Date.now() + CURSOR_TTL_MS,
      });
    }

    return {
      channel,
      changes,
      next_cursor: nextCursor,
      has_more: hasMore,
      server_time: new Date().toISOString(),
      overlap_window_versions: OVERLAP_VERSIONS.toString(),
    };
  }

  async push(user: AuthenticatedUser, body: PushSyncDto): Promise<Record<string, unknown>> {
    await this.assertDevice(user, body.device_id);
    const serializedBody = JSON.stringify(body);
    const byteLength = Buffer.byteLength(serializedBody, 'utf8');
    if (body.mutations.length > MAX_BATCH_MUTATIONS || byteLength > MAX_BATCH_BYTES
      || body.mutations.some((mutation) => Buffer.byteLength(JSON.stringify(mutation), 'utf8') > MAX_MUTATION_BYTES)) {
      throw new PayloadTooLargeException({ code: 'SYNC_BATCH_TOO_LARGE', message: 'El lote de sincronización supera los límites permitidos.', details: {
        max_mutations: MAX_BATCH_MUTATIONS, max_mutation_bytes: MAX_MUTATION_BYTES, max_batch_bytes: MAX_BATCH_BYTES,
      } });
    }

    const mutationIds = body.mutations.map((mutation) => mutation.mutation_id);
    if (new Set(mutationIds).size !== mutationIds.length) {
      throw new BadRequestException({ code: 'INVALID_SYNC_BATCH', message: 'Cada mutación del lote debe tener un mutation_id único.', details: {} });
    }

    const priorResults = new Map<string, MutationResult>();
    const results: MutationResult[] = [];
    for (const mutation of body.mutations) {
      const failedDependency = (mutation.depends_on_mutation_ids ?? []).find((id) => !priorResults.has(id) || priorResults.get(id)?.status !== 'applied');
      let result: MutationResult;
      if (failedDependency) {
        result = await this.storeRejectedMutation(user.id, body.device_id, mutation, 'MUTATION_DEPENDENCY_FAILED', {
          failed_dependency_id: failedDependency,
        });
      } else {
        result = await this.processMutation(user.id, body.device_id, mutation);
      }
      // La mutación queda confirmada en PostgreSQL antes de encolar; el worker valida
      // de nuevo el estado para evitar notificar cambios cancelados o ya procesados.
      if (mutation.entity === 'assistance_request' && mutation.operation === 'upsert'
        && result.status === 'applied' && result.server_data?.status === 'created') {
        await this.assistanceQueue.enqueueRequest(mutation.id);
      }
      priorResults.set(mutation.mutation_id, result);
      results.push(result);
    }
    return { results, server_time: new Date().toISOString() };
  }

  private async assertDevice(user: AuthenticatedUser, deviceId: string): Promise<void> {
    if (user.role !== 'user') throw new ForbiddenException({ code: 'SYNC_DRIVER_ROLE_REQUIRED', message: 'La sincronización offline de esta fase está disponible únicamente para cuentas de conductor.', details: {} });
    const account = await this.prisma.user.findFirst({
      where: { id: user.id, role: 'user', status: 'active', deletedAt: null },
      select: { id: true },
    });
    if (!account) throw new UnauthorizedException({ code: 'LOCAL_DATA_PURGE_REQUIRED', message: 'La cuenta ya no está disponible. Elimina los datos locales protegidos.', details: {} });
    if (deviceId !== user.device_id) throw new ForbiddenException({ code: 'DEVICE_NOT_OWNED', message: 'El dispositivo solicitado no coincide con la sesión autenticada.', details: {} });
    const device = await this.prisma.syncDevice.findFirst({ where: { id: deviceId, userId: user.id } });
    if (!device) throw new ForbiddenException({ code: 'DEVICE_NOT_OWNED', message: 'El dispositivo no pertenece a la cuenta autenticada.', details: {} });
    if (device.revokedAt || device.deletedAt) throw new UnauthorizedException({ code: 'LOCAL_DATA_PURGE_REQUIRED', message: 'El acceso de este dispositivo fue revocado. Elimina los datos locales protegidos.', details: {} });
  }

  private async maxVisibleSyncVersion(userId: string): Promise<bigint> {
    const result = await this.prisma.$queryRaw<Array<{ version: string }>>(Prisma.sql`
      SELECT COALESCE(MAX(version), 0)::text AS version FROM (
        SELECT sync_version AS version FROM public.users WHERE id = ${userId}::uuid
        UNION ALL SELECT sync_version FROM public.vehicles WHERE user_id = ${userId}::uuid
        UNION ALL SELECT sync_version FROM public.vehicle_documents WHERE user_id = ${userId}::uuid
        UNION ALL SELECT sync_version FROM public.insurance_policies WHERE user_id = ${userId}::uuid
        UNION ALL SELECT sync_version FROM public.notification_preferences WHERE user_id = ${userId}::uuid
        UNION ALL SELECT sync_version FROM public.emergency_contacts WHERE user_id = ${userId}::uuid
        UNION ALL SELECT sync_version FROM public.assistance_requests WHERE user_id = ${userId}::uuid
        UNION ALL SELECT sync_version FROM public.reminders WHERE user_id = ${userId}::uuid
      ) AS versions
    `);
    return BigInt(result[0]?.version ?? '0');
  }

  private async minimumValidCursor(): Promise<bigint> {
    const result = await this.prisma.$queryRaw<Array<{ minimum_valid_cursor: string }>>(Prisma.sql`
      SELECT minimum_valid_cursor::text AS minimum_valid_cursor FROM public.sync_retention_state WHERE id = 1
    `);
    return BigInt(result[0]?.minimum_valid_cursor ?? '0');
  }

  private overlapFloor(ack: bigint, minimumCursor: bigint): bigint {
    const overlap = ack > OVERLAP_VERSIONS ? ack - OVERLAP_VERSIONS : 0n;
    return overlap > minimumCursor ? overlap : minimumCursor;
  }

  private async acknowledgeCursor(userId: string, deviceId: string, channel: SyncChannel, cursor: bigint): Promise<void> {
    // Un cursor reconocido nunca retrocede, incluso si llegan dos pulls concurrentes.
    await this.prisma.$executeRaw(Prisma.sql`
      INSERT INTO public.sync_channel_states (user_id, device_id, channel, acknowledged_cursor, last_pulled_at)
      VALUES (${userId}::uuid, ${deviceId}::uuid, ${channel}, ${cursor}, clock_timestamp())
      ON CONFLICT (device_id, channel) DO UPDATE SET
        acknowledged_cursor = GREATEST(public.sync_channel_states.acknowledged_cursor, EXCLUDED.acknowledged_cursor),
        last_pulled_at = GREATEST(COALESCE(public.sync_channel_states.last_pulled_at, EXCLUDED.last_pulled_at), EXCLUDED.last_pulled_at),
        updated_at = clock_timestamp()
      WHERE public.sync_channel_states.user_id = EXCLUDED.user_id
    `);
    if (channel === 'all') {
      await this.prisma.$executeRaw(Prisma.sql`
        UPDATE public.sync_devices
        SET last_cursor = GREATEST(COALESCE(last_cursor, 0), ${cursor}), last_seen_at = clock_timestamp()
        WHERE id = ${deviceId}::uuid AND user_id = ${userId}::uuid
      `);
    }
  }

  private async loadBootstrapRows(userId: string, entity: SyncEntity, snapshot: bigint, afterId: string | null, take: number): Promise<SyncEntityRow[]> {
    const common = { userId, deletedAt: null, syncVersion: { lte: snapshot }, ...(afterId ? { id: { gt: afterId } } : {}) };
    switch (entity) {
      case 'profile': {
        if (afterId) return [];
        const row = await this.prisma.user.findFirst({ where: { id: userId, status: 'active', deletedAt: null, syncVersion: { lte: snapshot } } });
        return row ? [row] : [];
      }
      case 'vehicle': return this.prisma.vehicle.findMany({ where: common, orderBy: { id: 'asc' }, take });
      case 'vehicle_document': return this.prisma.vehicleDocument.findMany({ where: common, orderBy: { id: 'asc' }, take });
      case 'insurance_policy': return this.prisma.insurancePolicy.findMany({ where: common, include: { insurer: true, document: true }, orderBy: { id: 'asc' }, take });
      case 'notification_preference': return this.prisma.notificationPreference.findMany({ where: common, orderBy: { id: 'asc' }, take });
      case 'emergency_contact': return this.prisma.emergencyContact.findMany({ where: common, orderBy: { id: 'asc' }, take });
      case 'assistance_request': {
        const active = await this.prisma.assistanceRequest.findMany({ where: { ...common, status: { in: ACTIVE_ASSISTANCE_STATES } }, orderBy: { id: 'asc' } });
        const recentClosed = await this.prisma.assistanceRequest.findMany({
          where: { ...common, status: { in: ['completed', 'cancelled'] } },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 20,
        });
        const merged = [...new Map([...active, ...recentClosed].map((row) => [row.id, row])).values()]
          .filter((row) => !afterId || row.id > afterId).sort((a, b) => a.id.localeCompare(b.id));
        return merged.slice(0, take);
      }
      case 'reminder': return this.prisma.reminder.findMany({ where: common, orderBy: { id: 'asc' }, take });
    }
  }

  private async loadPullChanges(
    userId: string, entities: SyncEntity[], floor: bigint, watermark: bigint,
    afterVersion: bigint | null, afterEntity: string | null, afterId: string | null, take: number,
  ): Promise<Array<{ entity: SyncEntity; id: string; syncVersion: bigint; deletedAt: Date | null; updatedAt: Date; row: SyncEntityRow }>> {
    const output: Array<{ entity: SyncEntity; id: string; syncVersion: bigint; deletedAt: Date | null; updatedAt: Date; row: SyncEntityRow }> = [];
    for (const entity of entities) {
      const versionFilter: Record<string, bigint> = { gt: floor, lte: watermark };
      let additionalWhere: Record<string, unknown> = {};
      if (afterVersion !== null && afterEntity !== null && afterId !== null) {
        const entityCompare = entity.localeCompare(afterEntity);
        if (entityCompare < 0) {
          versionFilter.gt = afterVersion;
        } else if (entityCompare > 0) {
          versionFilter.gte = afterVersion;
          delete versionFilter.gt;
        } else {
          additionalWhere = {
            OR: [
              { syncVersion: { gt: afterVersion } },
              { syncVersion: afterVersion, id: { gt: afterId } },
            ],
          };
        }
      }

      if (entity === 'profile') {
        // La identidad es una proyección de lectura propia, no un conjunto multi-fila.
        const row = await this.prisma.user.findFirst({
          where: { id: userId, syncVersion: versionFilter, ...additionalWhere },
        });
        if (row) output.push({ entity, id: row.id, syncVersion: row.syncVersion, deletedAt: row.deletedAt, updatedAt: row.updatedAt, row });
        continue;
      }

      const baseWhere = { userId, syncVersion: versionFilter, ...additionalWhere };
      let rows: SyncEntityRow[] = [];
      switch (entity) {
        case 'vehicle': rows = await this.prisma.vehicle.findMany({ where: baseWhere as Prisma.VehicleWhereInput, orderBy: [{ syncVersion: 'asc' }, { id: 'asc' }], take }); break;
        case 'vehicle_document': rows = await this.prisma.vehicleDocument.findMany({ where: baseWhere as Prisma.VehicleDocumentWhereInput, orderBy: [{ syncVersion: 'asc' }, { id: 'asc' }], take }); break;
        case 'insurance_policy': rows = await this.prisma.insurancePolicy.findMany({ where: baseWhere as Prisma.InsurancePolicyWhereInput, include: { insurer: true, document: true }, orderBy: [{ syncVersion: 'asc' }, { id: 'asc' }], take }); break;
        case 'notification_preference': rows = await this.prisma.notificationPreference.findMany({ where: baseWhere as Prisma.NotificationPreferenceWhereInput, orderBy: [{ syncVersion: 'asc' }, { id: 'asc' }], take }); break;
        case 'emergency_contact': rows = await this.prisma.emergencyContact.findMany({ where: baseWhere as Prisma.EmergencyContactWhereInput, orderBy: [{ syncVersion: 'asc' }, { id: 'asc' }], take }); break;
        case 'assistance_request': rows = await this.prisma.assistanceRequest.findMany({ where: baseWhere as Prisma.AssistanceRequestWhereInput, orderBy: [{ syncVersion: 'asc' }, { id: 'asc' }], take }); break;
        case 'reminder': rows = await this.prisma.reminder.findMany({ where: baseWhere as Prisma.ReminderWhereInput, orderBy: [{ syncVersion: 'asc' }, { id: 'asc' }], take }); break;
      }
      for (const row of rows) output.push({ entity, id: row.id, syncVersion: row.syncVersion, deletedAt: row.deletedAt, updatedAt: row.updatedAt, row });
    }
    return output.sort((a, b) => a.syncVersion < b.syncVersion ? -1 : a.syncVersion > b.syncVersion ? 1 : a.entity.localeCompare(b.entity) || a.id.localeCompare(b.id)).slice(0, take);
  }

  private isValidVersionString(value: unknown): value is string {
    if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(value)) return false;
    try { return BigInt(value) <= 9_223_372_036_854_775_807n; } catch { return false; }
  }

  private async serializeEntity(entity: SyncEntity, row: SyncEntityRow, db: PrismaService | Prisma.TransactionClient): Promise<Record<string, unknown>> {
    switch (entity) {
      case 'profile': return this.serializeProfile(row as UserRow);
      case 'vehicle': return this.serializeVehicle(row as VehicleRow);
      case 'vehicle_document': return this.serializeDocument(row as VehicleDocumentRow);
      case 'insurance_policy': return this.serializePolicy(row as InsurancePolicyRow, db);
      case 'notification_preference': return this.serializePreference(row as NotificationPreferenceRow);
      case 'emergency_contact': return this.serializeEmergencyContact(row as EmergencyContactRow);
      case 'assistance_request': return this.serializeAssistanceRequest(row as AssistanceRequestRow, db);
      case 'reminder': return this.serializeReminder(row as ReminderRow);
    }
  }

  private async serializeProfile(row: UserRow): Promise<Record<string, unknown>> {
    const email = row.emailCiphertext && row.emailNonce && row.emailTag && row.emailEncryptedDek && row.emailKeyVersion
      ? await this.crypto.decrypt({ ciphertext: Buffer.from(row.emailCiphertext), nonce: Buffer.from(row.emailNonce), tag: Buffer.from(row.emailTag), encryptedDek: Buffer.from(row.emailEncryptedDek), keyVersion: row.emailKeyVersion }, 'users.email')
      : null;
    return { id: row.id, display_name: row.displayName, email, created_at: row.createdAt.toISOString(), updated_at: row.updatedAt.toISOString(), sync_version: row.syncVersion.toString() };
  }

  private async serializeVehicle(row: VehicleRow): Promise<Record<string, unknown>> {
    const plate = await this.crypto.decrypt({
      ciphertext: Buffer.from(row.plateCiphertext), nonce: Buffer.from(row.plateNonce), tag: Buffer.from(row.plateTag),
      encryptedDek: Buffer.from(row.plateEncryptedDek), keyVersion: row.plateKeyVersion, aadVersion: row.plateAadVersion,
    }, 'vehicles.plate', row.plateAadVersion === 2 ? { userId: row.userId, recordId: row.id } : undefined);
    const vin = row.vinCiphertext && row.vinNonce && row.vinTag && row.vinEncryptedDek && row.vinKeyVersion
      ? await this.crypto.decrypt({
        ciphertext: Buffer.from(row.vinCiphertext), nonce: Buffer.from(row.vinNonce), tag: Buffer.from(row.vinTag),
        encryptedDek: Buffer.from(row.vinEncryptedDek), keyVersion: row.vinKeyVersion, aadVersion: row.vinAadVersion ?? 1,
      }, 'vehicles.vin', row.vinAadVersion === 2 ? { userId: row.userId, recordId: row.id } : undefined) : null;
    return {
      id: row.id, plate, brand_id: row.brandId, brand: row.brandLabel, model_id: row.modelId, model: row.modelLabel,
      model_year: row.modelYear, color: row.color, vehicle_type: row.vehicleType, alias: row.nickname,
      vin, mileage_km: row.mileageKm, photo_status: row.photoStatus,
      photo_mime_type: row.photoMimeType, photo_size_bytes: row.photoSizeBytes?.toString() ?? null,
      created_at: row.createdAt.toISOString(), updated_at: row.updatedAt.toISOString(),
      deleted_at: row.deletedAt?.toISOString() ?? null, sync_version: row.syncVersion.toString(),
    };
  }

  private serializeDocument(row: VehicleDocumentRow): Record<string, unknown> {
    return {
      id: row.id, vehicle_id: row.vehicleId, document_type: row.documentType, title: row.title,
      issuer_name: row.issuerName, valid_from: this.dateOnly(row.validFrom), valid_until: this.dateOnly(row.validUntil),
      insurance_policy_id: row.insurancePolicyId, original_file_name: row.originalFileName,
      file_status: row.fileStatus, file_content_type: row.fileContentType,
      file_size_bytes: row.fileSizeBytes?.toString() ?? null,
      created_at: row.createdAt.toISOString(), updated_at: row.updatedAt.toISOString(),
      deleted_at: row.deletedAt?.toISOString() ?? null, sync_version: row.syncVersion.toString(),
    };
  }

  private async serializePolicy(row: InsurancePolicyRow, db: PrismaService | Prisma.TransactionClient): Promise<Record<string, unknown>> {
    const policy = row.insurer !== undefined && row.document !== undefined ? row : await db.insurancePolicy.findFirst({ where: { id: row.id, userId: row.userId }, include: { insurer: true, document: true } });
    if (!policy) throw new NotFoundException({ code: 'RESOURCE_NOT_FOUND', message: 'No se encontró la póliza.', details: {} });
    const policyNumber = await this.crypto.decrypt({
      ciphertext: Buffer.from(policy.policyNumberCiphertext), nonce: Buffer.from(policy.policyNumberNonce),
      tag: Buffer.from(policy.policyNumberTag), encryptedDek: Buffer.from(policy.policyNumberEncryptedDek),
      keyVersion: policy.policyNumberKeyVersion, aadVersion: policy.policyNumberAadVersion,
    }, 'insurance_policies.policy_number', { userId: policy.userId, recordId: policy.id });
    const claimsPhone = policy.claimsPhoneCiphertext && policy.claimsPhoneNonce && policy.claimsPhoneTag && policy.claimsPhoneEncryptedDek && policy.claimsPhoneKeyVersion
      ? await this.crypto.decrypt({
        ciphertext: Buffer.from(policy.claimsPhoneCiphertext), nonce: Buffer.from(policy.claimsPhoneNonce), tag: Buffer.from(policy.claimsPhoneTag),
        encryptedDek: Buffer.from(policy.claimsPhoneEncryptedDek), keyVersion: policy.claimsPhoneKeyVersion,
        aadVersion: policy.claimsPhoneAadVersion ?? 2,
      }, 'insurance_policies.claims_phone', { userId: policy.userId, recordId: policy.id }) : null;
    return {
      id: policy.id, vehicle_id: policy.vehicleId, document_id: policy.document?.id ?? null,
      insurer: policy.insurer ? { id: policy.insurer.id, name: policy.insurer.name } : null,
      insurer_id: policy.insurerId, other_insurer_name: policy.otherInsurerName, policy_number: policyNumber,
      valid_from: this.dateOnly(policy.validFrom), valid_until: this.dateOnly(policy.validUntil),
      deductible: policy.deductible?.toString() ?? null, premium: policy.premium?.toString() ?? null,
      currency: policy.currency, claims_phone: claimsPhone, history_status: policy.status,
      previous_policy_id: policy.previousPolicyId, archived_at: policy.archivedAt?.toISOString() ?? null,
      created_at: policy.createdAt.toISOString(), updated_at: policy.updatedAt.toISOString(),
      deleted_at: policy.deletedAt?.toISOString() ?? null, sync_version: policy.syncVersion.toString(),
    };
  }

  private serializePreference(row: NotificationPreferenceRow): Record<string, unknown> {
    return {
      id: row.id, category: row.category, enabled_offsets: row.enabledOffsets, preferred_time: row.preferredTime,
      push_enabled: row.pushEnabled, local_enabled: row.localEnabled, in_app_enabled: row.inAppEnabled,
      timezone: row.timezone, created_at: row.createdAt.toISOString(), updated_at: row.updatedAt.toISOString(),
      deleted_at: row.deletedAt?.toISOString() ?? null, sync_version: row.syncVersion.toString(),
    };
  }

  private async serializeEmergencyContact(row: EmergencyContactRow): Promise<Record<string, unknown>> {
    const phone = row.phoneCiphertext && row.phoneNonce && row.phoneTag && row.phoneEncryptedDek && row.phoneKeyVersion
      ? await this.crypto.decrypt({
        ciphertext: Buffer.from(row.phoneCiphertext), nonce: Buffer.from(row.phoneNonce), tag: Buffer.from(row.phoneTag),
        encryptedDek: Buffer.from(row.phoneEncryptedDek), keyVersion: row.phoneKeyVersion, aadVersion: row.phoneAadVersion ?? 1,
      }, 'emergency_contacts.phone', (row.phoneAadVersion ?? 1) >= 2 ? { userId: row.userId, recordId: row.id } : undefined)
      : null;
    return {
      id: row.id, name: row.name, relationship_label: row.relationshipLabel, phone_e164: phone,
      is_primary: row.isPrimary, created_at: row.createdAt.toISOString(), updated_at: row.updatedAt.toISOString(),
      deleted_at: row.deletedAt?.toISOString() ?? null, sync_version: row.syncVersion.toString(),
    };
  }

  private async serializeAssistanceRequest(row: AssistanceRequestRow, db: PrismaService | Prisma.TransactionClient): Promise<Record<string, unknown>> {
    const phone = row.contactPhoneCiphertext && row.contactPhoneNonce && row.contactPhoneTag && row.contactPhoneEncryptedDek && row.contactPhoneKeyVersion
      ? await this.crypto.decrypt({
        ciphertext: Buffer.from(row.contactPhoneCiphertext), nonce: Buffer.from(row.contactPhoneNonce), tag: Buffer.from(row.contactPhoneTag),
        encryptedDek: Buffer.from(row.contactPhoneEncryptedDek), keyVersion: row.contactPhoneKeyVersion, aadVersion: row.contactPhoneAadVersion ?? 2,
      }, 'assistance_requests.contact_phone', { userId: row.userId, recordId: row.id }) : null;
    const coords = await db.$queryRaw<Array<{ latitude: number | null; longitude: number | null }>>(Prisma.sql`
      SELECT ST_Y(location::geometry) AS latitude, ST_X(location::geometry) AS longitude
      FROM public.assistance_requests WHERE id = ${row.id}::uuid AND user_id = ${row.userId}::uuid
    `);
    return {
      id: row.id, vehicle_id: row.vehicleId, service_type_id: row.serviceTypeId,
      assistance_provider_id: row.assistanceProviderId, issue_description: row.issueDescription, address_reference_text: row.addressReferenceText,
      latitude: coords[0]?.latitude ?? null, longitude: coords[0]?.longitude ?? null,
      department_id: row.departmentId, municipality_id: row.municipalityId,
      contact_phone: phone, preferred_contact: row.preferredContact, status: row.status,
      requested_at: row.requestedAt.toISOString(), sent_at: row.sentAt?.toISOString() ?? null,
      accepted_at: row.acceptedAt?.toISOString() ?? null, en_camino_at: row.enRouteAt?.toISOString() ?? null,
      completed_at: row.completedAt?.toISOString() ?? null, cancelled_at: row.cancelledAt?.toISOString() ?? null,
      created_at: row.createdAt.toISOString(), updated_at: row.updatedAt.toISOString(),
      deleted_at: row.deletedAt?.toISOString() ?? null, sync_version: row.syncVersion.toString(),
    };
  }

  private serializeReminder(row: ReminderRow): Record<string, unknown> {
    return {
      id: row.id, vehicle_document_id: row.vehicleDocumentId, title: row.title, description: row.description,
      reminder_type: row.reminderType, due_at: row.dueAt.toISOString(), scheduled_at: row.scheduledAt.toISOString(),
      lead_time_days: row.leadTimeDays, channel: row.channel, status: row.status,
      sent_at: row.sentAt?.toISOString() ?? null,
      cancelled_at: row.cancelledAt?.toISOString() ?? null, created_at: row.createdAt.toISOString(),
      updated_at: row.updatedAt.toISOString(), deleted_at: row.deletedAt?.toISOString() ?? null,
      sync_version: row.syncVersion.toString(),
    };
  }

  private dateOnly(value: Date | null | undefined): string | null { return value ? value.toISOString().slice(0, 10) : null; }

  private signToken<T extends { exp: number }>(payload: T): string {
    const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const signature = createHmac('sha256', this.config.value.jwtAccessSecret).update(`vehicular-sync-v1.${encoded}`).digest('base64url');
    return `${encoded}.${signature}`;
  }

  private readSignedToken<T extends { exp: number }>(token: string, errorCode: 'INVALID_CURSOR' | 'BOOTSTRAP_TOKEN_INVALID'): T {
    const parts = token.split('.');
    if (parts.length !== 2 || parts[0].length > 8192 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]{43}$/.test(parts[1])) throw errorCode === 'INVALID_CURSOR' ? this.invalidCursor() : this.bootstrapTokenInvalid();
    const expected = createHmac('sha256', this.config.value.jwtAccessSecret).update(`vehicular-sync-v1.${parts[0]}`).digest();
    let received: Buffer;
    try { received = Buffer.from(parts[1], 'base64url'); } catch { throw errorCode === 'INVALID_CURSOR' ? this.invalidCursor() : this.bootstrapTokenInvalid(); }
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) throw errorCode === 'INVALID_CURSOR' ? this.invalidCursor() : this.bootstrapTokenInvalid();
    let payload: T;
    try { payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as T; } catch { throw errorCode === 'INVALID_CURSOR' ? this.invalidCursor() : this.bootstrapTokenInvalid(); }
    if (!payload || typeof payload !== 'object' || !Number.isFinite(payload.exp) || payload.exp <= Date.now()) {
      if (errorCode === 'INVALID_CURSOR') throw this.resyncRequired();
      throw new GoneException({ code: 'BOOTSTRAP_EXPIRED', message: 'La instantánea expiró. Inicia un bootstrap nuevo.', details: {} });
    }
    return payload;
  }

  private invalidCursor(): BadRequestException { return new BadRequestException({ code: 'INVALID_CURSOR', message: 'El cursor de sincronización no es válido.', details: {} }); }
  private bootstrapTokenInvalid(): ConflictException { return new ConflictException({ code: 'BOOTSTRAP_TOKEN_INVALID', message: 'El token de página no corresponde a esta instantánea o fue alterado.', details: {} }); }
  private resyncRequired(): GoneException { return new GoneException({ code: 'SYNC_RESYNC_REQUIRED', message: 'El cursor ya venció o quedó por debajo del mínimo válido. Realiza un bootstrap completo.', details: { cursor_validity_days: CURSOR_VALIDITY_DAYS } }); }

  private async processMutation(userId: string, deviceId: string, mutation: SyncMutationDto): Promise<MutationResult> {
    const payloadHash = this.hashPayload(mutation);
    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${userId}:${mutation.mutation_id}`}, 0))`);
        await this.assertDeviceInTransaction(tx, userId, deviceId);
        const prior = await tx.processedMutation.findUnique({ where: { userId_mutationId: { userId, mutationId: mutation.mutation_id } } });
        if (prior) {
          if (!Buffer.from(prior.payloadHash).equals(payloadHash)) return this.resultBase(mutation, 'rejected', 'MUTATION_ID_REUSE');
          return this.decryptStoredResult(prior, userId, mutation.mutation_id);
        }
        const result = await this.applyMutation(tx, userId, mutation);
        await this.storeMutationResult(tx, userId, deviceId, mutation, payloadHash, result);
        return result;
      }, { timeout: 15_000, maxWait: 5_000 });
    } catch (error) {
      if (error instanceof HttpException) {
        // Un error 5xx no es un rechazo permanente de la mutación. Conservar
        // la cola local y permitir que el cliente reintente con el mismo ID.
        if (error.getStatus() >= 500) throw error;
        const reason = this.safeExceptionCode(error);
        return this.storeRejectedMutation(userId, deviceId, mutation, reason);
      }
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        // Deadlocks, conflictos serializables y agotamiento del pool son
        // transitorios: nunca deben quedar cacheados como resultado rejected.
        if (['P2024', 'P2034'].includes(error.code)) {
          throw new ServiceUnavailableException({
            code: 'SYNC_TEMPORARILY_UNAVAILABLE',
            message: 'La sincronización no está disponible temporalmente. Conserva la mutación y vuelve a intentarlo.',
            details: {},
          });
        }
        const reason = error.code === 'P2002' ? 'MUTATION_CONFLICT' : error.code === 'P2003' ? 'CATALOG_REFERENCE_INVALID' : 'VALIDATION_ERROR';
        return this.storeRejectedMutation(userId, deviceId, mutation, reason);
      }
      throw error;
    }
  }

  private async storeRejectedMutation(
    userId: string, deviceId: string, mutation: SyncMutationDto, reason: string,
    details: Record<string, unknown> = {},
  ): Promise<MutationResult> {
    const payloadHash = this.hashPayload(mutation);
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${userId}:${mutation.mutation_id}`}, 0))`);
      await this.assertDeviceInTransaction(tx, userId, deviceId);
      const prior = await tx.processedMutation.findUnique({ where: { userId_mutationId: { userId, mutationId: mutation.mutation_id } } });
      if (prior) {
        if (!Buffer.from(prior.payloadHash).equals(payloadHash)) return this.resultBase(mutation, 'rejected', 'MUTATION_ID_REUSE');
        return this.decryptStoredResult(prior, userId, mutation.mutation_id);
      }
      const result = this.resultBase(mutation, 'rejected', reason, details);
      await this.storeMutationResult(tx, userId, deviceId, mutation, payloadHash, result);
      return result;
    }, { timeout: 10_000, maxWait: 5_000 });
  }

  private async assertDeviceInTransaction(tx: Prisma.TransactionClient, userId: string, deviceId: string): Promise<void> {
    const [device, account] = await Promise.all([
      tx.syncDevice.findFirst({ where: { id: deviceId, userId } }),
      tx.user.findFirst({ where: { id: userId, role: 'user', status: 'active', deletedAt: null }, select: { id: true } }),
    ]);
    if (!account) throw new UnauthorizedException({ code: 'LOCAL_DATA_PURGE_REQUIRED', message: 'La cuenta ya no está disponible. Elimina los datos locales protegidos.', details: {} });
    if (!device) throw new ForbiddenException({ code: 'DEVICE_NOT_OWNED', message: 'El dispositivo no pertenece a la cuenta autenticada.', details: {} });
    if (device.revokedAt || device.deletedAt) throw new UnauthorizedException({ code: 'LOCAL_DATA_PURGE_REQUIRED', message: 'El dispositivo fue revocado. Elimina los datos locales protegidos.', details: {} });
  }

  private async storeMutationResult(
    tx: Prisma.TransactionClient, userId: string, deviceId: string, mutation: SyncMutationDto,
    payloadHash: Buffer, result: MutationResult,
  ): Promise<void> {
    const encrypted = await this.crypto.encrypt(JSON.stringify(result), 'sync.processed_mutations.result', {
      userId, recordId: mutation.mutation_id,
    });
    await tx.processedMutation.create({ data: {
      userId, mutationId: mutation.mutation_id, deviceId, entity: mutation.entity, entityId: mutation.id,
      payloadHash: prismaBytes(payloadHash), resultCiphertext: prismaBytes(encrypted.ciphertext), resultNonce: prismaBytes(encrypted.nonce),
      resultTag: prismaBytes(encrypted.tag), resultEncryptedDek: prismaBytes(encrypted.encryptedDek), resultKeyVersion: encrypted.keyVersion,
    } });
  }

  private async decryptStoredResult(row: ProcessedMutationRow, userId: string, mutationId: string): Promise<MutationResult> {
    const plaintext = await this.crypto.decrypt({
      ciphertext: Buffer.from(row.resultCiphertext), nonce: Buffer.from(row.resultNonce), tag: Buffer.from(row.resultTag),
      encryptedDek: Buffer.from(row.resultEncryptedDek), keyVersion: row.resultKeyVersion, aadVersion: 2,
    }, 'sync.processed_mutations.result', { userId, recordId: mutationId });
    return JSON.parse(plaintext) as MutationResult;
  }

  private hashPayload(mutation: SyncMutationDto): Buffer {
    return createHash('sha256').update(this.canonicalJson(mutation)).digest();
  }

  private canonicalJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map((item) => this.canonicalJson(item)).join(',')}]`;
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${this.canonicalJson(record[key])}`).join(',')}}`;
    }
    return JSON.stringify(value) ?? 'null';
  }

  private resultBase(
    mutation: SyncMutationDto, status: MutationResult['status'], reason?: string,
    details: Record<string, unknown> = {},
  ): MutationResult {
    return {
      mutation_id: mutation.mutation_id, entity: mutation.entity, id: mutation.id, status,
      server_sync_version: null, server_updated_at: null, conflict_resolution: null,
      reason: reason ?? null, ...(Object.keys(details).length ? { details } : {}),
      server_data: null,
    };
  }

  private safeExceptionCode(error: HttpException): string {
    const response = error.getResponse();
    if (response && typeof response === 'object' && 'code' in response && typeof response.code === 'string') {
      const code = response.code;
      return /^[A-Z0-9_]{2,80}$/.test(code) ? code : 'VALIDATION_ERROR';
    }
    return error.getStatus() === 404 ? 'RESOURCE_NOT_FOUND' : error.getStatus() === 409 ? 'MUTATION_CONFLICT' : 'VALIDATION_ERROR';
  }

  private async applyMutation(tx: Prisma.TransactionClient, userId: string, mutation: SyncMutationDto): Promise<MutationResult> {
    if (mutation.operation === 'upsert' && (!mutation.data || typeof mutation.data !== 'object' || Array.isArray(mutation.data) || Object.keys(mutation.data).length === 0)) {
      throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'La mutación requiere un objeto data con al menos un campo.', details: {} });
    }
    if (mutation.operation === 'delete' && mutation.data != null) {
      throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'Una eliminación no debe incluir data.', details: {} });
    }
    if (mutation.entity !== 'profile' && !isUuidV7(mutation.id)) {
      throw new BadRequestException({ code: 'ID_INVALID', message: 'Las entidades offline requieren UUID v7.', details: {} });
    }
    if (!['profile', 'vehicle', 'vehicle_document', 'insurance_policy', 'notification_preference', 'emergency_contact', 'assistance_request'].includes(mutation.entity)) {
      throw new UnprocessableEntityException({ code: 'ENTITY_NOT_SYNCABLE', message: 'La entidad no admite escritura mediante sincronización offline.', details: {} });
    }

    const clientTimeRaw = new Date(mutation.client_updated_at);
    if (!Number.isFinite(clientTimeRaw.getTime())) throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'client_updated_at debe ser una fecha ISO válida.', details: {} });
    const now = new Date();
    const clientTime = clientTimeRaw.getTime() > now.getTime() + 5 * 60_000 ? now : clientTimeRaw;

    let row: SyncEntityRow | null = null;
    let version: bigint | null = null;
    let updatedAt: Date | null = null;
    let isConflict = false;

    switch (mutation.entity) {
      case 'profile':
        if (mutation.id !== userId) throw new ForbiddenException({ code: 'RESOURCE_NOT_OWNED', message: 'El perfil solicitado no pertenece a la sesión.', details: {} });
        if (mutation.operation === 'delete') throw new UnprocessableEntityException({ code: 'ENTITY_NOT_SYNCABLE', message: 'La identidad no se elimina mediante sync/push.', details: {} });
        row = await tx.user.findFirst({ where: { id: userId, status: 'active', deletedAt: null } });
        if (!row) throw new NotFoundException({ code: 'RESOURCE_NOT_FOUND', message: 'No se encontró el perfil.', details: {} });
        if (clientTime <= row.updatedAt) isConflict = true;
        else row = await this.applyProfileMutation(tx, userId, mutation.data!);
        break;
      case 'vehicle': {
        const result = await this.applyVehicleMutation(tx, userId, mutation, clientTime);
        row = result.row; isConflict = result.conflict;
        break;
      }
      case 'vehicle_document': {
        const result = await this.applyDocumentMutation(tx, userId, mutation, clientTime);
        row = result.row; isConflict = result.conflict;
        break;
      }
      case 'insurance_policy': {
        const result = await this.applyPolicyMutation(tx, userId, mutation, clientTime);
        row = result.row; isConflict = result.conflict;
        break;
      }
      case 'notification_preference': {
        const result = await this.applyPreferenceMutation(tx, userId, mutation, clientTime);
        row = result.row; isConflict = result.conflict;
        break;
      }
      case 'emergency_contact': {
        const result = await this.applyEmergencyContactMutation(tx, userId, mutation, clientTime);
        row = result.row; isConflict = result.conflict;
        break;
      }
      case 'assistance_request': {
        const result = await this.applyAssistanceRequestMutation(tx, userId, mutation, clientTime);
        row = result.row; isConflict = result.conflict;
        break;
      }
      default:
        throw new UnprocessableEntityException({ code: 'ENTITY_NOT_SYNCABLE', message: 'La entidad no admite escritura mediante sincronización offline.', details: {} });
    }

    if (!row) throw new NotFoundException({ code: 'RESOURCE_NOT_FOUND', message: 'No se encontró el registro de sincronización.', details: {} });
    const entity = mutation.entity as SyncEntity;
    const serialized = await this.serializeEntity(entity, row, tx);
    version = row.syncVersion;
    updatedAt = row.updatedAt;
    return {
      mutation_id: mutation.mutation_id, entity: mutation.entity, id: mutation.id,
      status: isConflict ? 'conflict' : 'applied',
      server_sync_version: version.toString(), server_updated_at: updatedAt.toISOString(),
      conflict_resolution: isConflict ? 'server_wins_lww' : 'client_wins_lww',
      reason: isConflict ? 'MUTATION_CONFLICT' : null,
      ...(isConflict ? { details: { base_sync_version: mutation.base_sync_version ?? null } } : {}),
      server_data: serialized,
    };
  }

  private assertAllowedKeys(data: JsonObject, allowed: string[], required: string[] = []): void {
    const keys = Object.keys(data);
    const invalid = keys.filter((key) => !allowed.includes(key));
    if (invalid.length) throw new BadRequestException({ code: 'FIELD_NOT_MUTABLE', message: 'La mutación contiene campos no editables.', details: { fields: invalid } });
    const missing = required.filter((key) => data[key] === undefined || data[key] === null);
    if (missing.length) throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'Faltan campos obligatorios.', details: { fields: missing } });
  }

  private ensureUuid(value: unknown, field: string, required = false): string | null {
    if (value === undefined || value === null || value === '') {
      if (required) throw new BadRequestException({ code: 'VALIDATION_ERROR', message: `${field} es obligatorio.`, details: {} });
      return null;
    }
    if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
      throw new BadRequestException({ code: 'VALIDATION_ERROR', message: `${field} no es un UUID válido.`, details: {} });
    }
    return value;
  }

  private ensureDate(value: unknown, field: string, required = false): Date | null {
    if (value === undefined || value === null || value === '') {
      if (required) throw new BadRequestException({ code: 'VALIDATION_ERROR', message: `${field} es obligatorio.`, details: {} });
      return null;
    }
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new BadRequestException({ code: 'VALIDATION_ERROR', message: `${field} debe usar YYYY-MM-DD.`, details: {} });
    const date = new Date(`${value}T00:00:00.000Z`);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new BadRequestException({ code: 'VALIDATION_ERROR', message: `${field} no es una fecha válida.`, details: {} });
    return date;
  }

  private ensureString(value: unknown, field: string, min: number, max: number, required = false): string | null {
    if (value === undefined || value === null) {
      if (required) throw new BadRequestException({ code: 'VALIDATION_ERROR', message: `${field} es obligatorio.`, details: {} });
      return null;
    }
    if (typeof value !== 'string') throw new BadRequestException({ code: 'VALIDATION_ERROR', message: `${field} debe ser texto.`, details: {} });
    const text = value.trim();
    if ((required && text.length < min) || (!required && text.length > 0 && text.length < min) || text.length > max) {
      throw new BadRequestException({ code: 'VALIDATION_ERROR', message: `${field} no cumple la longitud permitida.`, details: {} });
    }
    if (required && !text) throw new BadRequestException({ code: 'VALIDATION_ERROR', message: `${field} es obligatorio.`, details: {} });
    return text || null;
  }

  private async conflictOrOwned(tx: Prisma.TransactionClient, model: 'vehicle', id: string, userId: string): Promise<VehicleRow | null>;
  private async conflictOrOwned(tx: Prisma.TransactionClient, model: 'vehicle_document', id: string, userId: string): Promise<VehicleDocumentRow | null>;
  private async conflictOrOwned(tx: Prisma.TransactionClient, model: 'insurance_policy', id: string, userId: string): Promise<InsurancePolicyRow | null>;
  private async conflictOrOwned(tx: Prisma.TransactionClient, model: 'emergency_contact', id: string, userId: string): Promise<EmergencyContactRow | null>;
  private async conflictOrOwned(tx: Prisma.TransactionClient, model: 'assistance_request', id: string, userId: string): Promise<AssistanceRequestRow | null>;
  private async conflictOrOwned(
    tx: Prisma.TransactionClient,
    model: 'vehicle' | 'vehicle_document' | 'insurance_policy' | 'emergency_contact' | 'assistance_request',
    id: string,
    userId: string,
  ): Promise<VehicleRow | VehicleDocumentRow | InsurancePolicyRow | EmergencyContactRow | AssistanceRequestRow | null> {
    const record = model === 'vehicle' ? await tx.vehicle.findUnique({ where: { id } })
      : model === 'vehicle_document' ? await tx.vehicleDocument.findUnique({ where: { id } })
        : model === 'insurance_policy' ? await tx.insurancePolicy.findUnique({ where: { id } })
          : model === 'emergency_contact' ? await tx.emergencyContact.findUnique({ where: { id } })
            : await tx.assistanceRequest.findUnique({ where: { id } });
    if (record && record.userId !== userId) throw new ConflictException({ code: 'ID_COLLISION', message: 'El identificador ya está ocupado por otro registro.', details: {} });
    return record;
  }

  private async checkLww(existing: { updatedAt: Date }, clientTime: Date): Promise<boolean> {
    return clientTime.getTime() <= existing.updatedAt.getTime();
  }

  private async applyProfileMutation(tx: Prisma.TransactionClient, userId: string, data: JsonObject): Promise<UserRow> {
    this.assertAllowedKeys(data, ['display_name', 'email']);
    if (data.display_name === undefined && data.email === undefined) throw new BadRequestException({ code: 'EMPTY_PROFILE_UPDATE', message: 'Indica al menos un campo del perfil.', details: {} });
    const update: Prisma.UserUpdateInput = {};
    if (data.display_name !== undefined) update.displayName = this.ensureString(data.display_name, 'display_name', 1, 120, true)!;
    if (data.email !== undefined) {
      const email = this.ensureString(data.email, 'email', 3, 254, true)!.toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'El correo electrónico no tiene un formato válido.', details: {} });
      const [encrypted, index] = await Promise.all([
        this.crypto.encrypt(email, 'users.email'), this.crypto.blindIndex(email, 'users.email'),
      ]);
      Object.assign(update, {
        emailCiphertext: prismaBytes(encrypted.ciphertext), emailNonce: prismaBytes(encrypted.nonce), emailTag: prismaBytes(encrypted.tag),
        emailEncryptedDek: prismaBytes(encrypted.encryptedDek), emailKeyVersion: encrypted.keyVersion,
        emailHmac: prismaBytes(index.digest), emailHmacKeyVersion: index.keyVersion,
      });
    }
    try {
      return await tx.user.update({ where: { id: userId }, data: update });
    } catch (error) { throw error; }
  }

  private async applyVehicleMutation(
    tx: Prisma.TransactionClient, userId: string, mutation: SyncMutationDto, clientTime: Date,
  ): Promise<{ row: VehicleRow; conflict: boolean }> {
    const data = mutation.data ?? {};
    const existing = await this.conflictOrOwned(tx, 'vehicle', mutation.id, userId);
    if (mutation.operation === 'delete') {
      if (!existing) throw new NotFoundException({ code: 'RESOURCE_NOT_FOUND', message: 'No se encontró el vehículo.', details: {} });
      if (existing.deletedAt) return { row: existing, conflict: false };
      if (await this.checkLww(existing, clientTime)) return { row: existing, conflict: true };
      const deletedAt = new Date();
      const docs = await tx.vehicleDocument.findMany({ where: { userId, vehicleId: mutation.id, deletedAt: null }, select: { id: true } });
      for (const doc of docs) await this.reminders.cancelForDocument(tx, userId, doc.id, deletedAt);
      await tx.vehicleDocument.updateMany({ where: { userId, vehicleId: mutation.id, deletedAt: null }, data: { deletedAt } });
      await tx.insurancePolicy.updateMany({
        where: { userId, vehicleId: mutation.id, deletedAt: null },
        data: { deletedAt, status: 'archived', archivedAt: deletedAt },
      });
      const row = await tx.vehicle.update({ where: { id: mutation.id }, data: { deletedAt } });
      return { row, conflict: false };
    }

    this.assertAllowedKeys(data, [
      'plate', 'brand', 'model', 'brand_id', 'model_id', 'model_year', 'vehicle_type', 'color', 'nickname', 'vin', 'mileage_km',
    ], existing ? [] : ['plate', 'model_year', 'vehicle_type']);
    if (existing?.deletedAt) throw new ConflictException({ code: 'RESOURCE_RETIRED', message: 'El vehículo ya fue eliminado y no puede reactivarse.', details: {} });
    if (existing && await this.checkLww(existing, clientTime)) return { row: existing, conflict: true };

    const plateRaw = data.plate === undefined && existing
      ? await this.decryptVehiclePlate(existing)
      : this.ensureString(data.plate, 'plate', 3, 16, true)!.toUpperCase().replace(/\s+/g, '');
    if (!/^[A-Z0-9-]{3,16}$/.test(plateRaw)) throw new BadRequestException({ code: 'PLATE_FORMAT_INVALID', message: 'La placa contiene caracteres no permitidos.', details: {} });
    const brandId = data.brand_id === undefined ? existing?.brandId ?? null : this.ensureUuid(data.brand_id, 'brand_id');
    const modelId = data.model_id === undefined ? existing?.modelId ?? null : this.ensureUuid(data.model_id, 'model_id');
    let brandLabel = data.brand === undefined ? existing?.brandLabel ?? null : this.ensureString(data.brand, 'brand', 1, 80, true);
    let modelLabel = data.model === undefined ? existing?.modelLabel ?? null : this.ensureString(data.model, 'model', 1, 100, true);
    if (brandId) {
      const brand = await tx.vehicleBrand.findFirst({ where: { id: brandId, isActive: true } });
      if (!brand) throw new BadRequestException({ code: 'VEHICLE_BRAND_INVALID', message: 'La marca seleccionada no está disponible.', details: {} });
      brandLabel = brand.name;
    }
    if (modelId) {
      if (!brandId) throw new BadRequestException({ code: 'VEHICLE_MODEL_BRAND_REQUIRED', message: 'Selecciona la marca del modelo.', details: {} });
      const model = await tx.vehicleModel.findFirst({ where: { id: modelId, brandId, isActive: true } });
      if (!model) throw new BadRequestException({ code: 'VEHICLE_MODEL_BRAND_MISMATCH', message: 'El modelo no pertenece a la marca seleccionada o no está disponible.', details: {} });
      modelLabel = model.name;
    }
    if (!brandLabel || !modelLabel) throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'Indica la marca y el modelo, mediante texto o una referencia válida del catálogo.', details: {} });
    if (modelId && !brandId) throw new BadRequestException({ code: 'VEHICLE_MODEL_BRAND_REQUIRED', message: 'El modelo requiere una marca.', details: {} });

    const modelYear = data.model_year === undefined ? existing?.modelYear : Number(data.model_year);
    const currentYear = Number(new Intl.DateTimeFormat('en', { timeZone: 'America/Managua', year: 'numeric' }).format(new Date()));
    if (typeof modelYear !== 'number' || !Number.isInteger(modelYear) || modelYear < 1950 || modelYear > currentYear + 1) throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'model_year está fuera del rango permitido.', details: {} });
    const vehicleType = data.vehicle_type === undefined ? existing?.vehicleType : data.vehicle_type;
    if (typeof vehicleType !== 'string' || !ALLOWED_VEHICLE_TYPES.has(vehicleType)) throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'vehicle_type no es válido.', details: {} });
    const color = data.color === undefined ? existing?.color ?? null : this.ensureString(data.color, 'color', 1, 40);
    const nickname = data.nickname === undefined ? existing?.nickname ?? null : this.ensureString(data.nickname, 'nickname', 1, 80);
    const mileage = data.mileage_km === undefined ? existing?.mileageKm ?? null : data.mileage_km === null ? null : Number(data.mileage_km);
    if (mileage !== null && (!Number.isInteger(mileage) || mileage < 0 || mileage > 2_000_000)) throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'mileage_km debe ser un entero no negativo.', details: {} });

    const plateIndex = await this.crypto.blindIndex(plateRaw, 'vehicles.plate');
    const duplicate = await tx.vehicle.findFirst({ where: { userId, plateHmac: prismaBytes(plateIndex.digest), deletedAt: null, id: { not: mutation.id } }, select: { id: true } });
    if (duplicate) throw new ConflictException({ code: 'PLATE_ALREADY_REGISTERED', message: 'Esta placa ya está registrada en la cuenta.', details: {} });
    const plateEncrypted = data.plate !== undefined || !existing
      ? await this.crypto.encrypt(plateRaw, 'vehicles.plate', { userId, recordId: mutation.id }) : null;
    let vinFields: VehicleVinFields = {};
    if (data.vin !== undefined) {
      if (data.vin === null || data.vin === '') {
        vinFields = { vinCiphertext: null, vinNonce: null, vinTag: null, vinEncryptedDek: null, vinKeyVersion: null, vinAadVersion: null, vinHmac: null, vinHmacKeyVersion: null };
      } else {
        const vin = this.ensureString(data.vin, 'vin', 5, 32, true)!.toUpperCase().replace(/\s+/g, '');
        if (!/^[A-HJ-NPR-Z0-9]+$/.test(vin)) throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'vin contiene caracteres no permitidos.', details: {} });
        const [encrypted, index] = await Promise.all([this.crypto.encrypt(vin, 'vehicles.vin', { userId, recordId: mutation.id }), this.crypto.blindIndex(vin, 'vehicles.vin')]);
        vinFields = { vinCiphertext: prismaBytes(encrypted.ciphertext), vinNonce: prismaBytes(encrypted.nonce), vinTag: prismaBytes(encrypted.tag), vinEncryptedDek: prismaBytes(encrypted.encryptedDek), vinKeyVersion: encrypted.keyVersion, vinAadVersion: encrypted.aadVersion ?? 2, vinHmac: prismaBytes(index.digest), vinHmacKeyVersion: index.keyVersion };
      }
    }

    if (!existing) {
      await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${userId}, 0))`);
      const count = await tx.vehicle.count({ where: { userId, deletedAt: null } });
      if (count >= this.config.value.maxVehiclesPerUser) throw new ConflictException({ code: 'VEHICLE_LIMIT_REACHED', message: 'Se alcanzó el máximo de vehículos activos de la cuenta.', details: { maximum: this.config.value.maxVehiclesPerUser } });
      const row = await tx.vehicle.create({ data: {
        id: mutation.id, userId, plateCiphertext: prismaBytes(plateEncrypted!.ciphertext), plateNonce: prismaBytes(plateEncrypted!.nonce),
        plateTag: prismaBytes(plateEncrypted!.tag), plateEncryptedDek: prismaBytes(plateEncrypted!.encryptedDek), plateKeyVersion: plateEncrypted!.keyVersion,
        plateAadVersion: plateEncrypted!.aadVersion ?? 2, plateHmac: prismaBytes(plateIndex.digest), plateHmacKeyVersion: plateIndex.keyVersion,
        brandId, brandLabel, modelId, modelLabel, modelYear: modelYear!, vehicleType: vehicleType as VehicleType,
        color, nickname, mileageKm: mileage, ...vinFields,
      } });
      return { row, conflict: false };
    }
    const update: Prisma.VehicleUncheckedUpdateInput = { brandId, brandLabel, modelId, modelLabel, modelYear, vehicleType: vehicleType as VehicleType, color, nickname, mileageKm: mileage, ...vinFields };
    if (plateEncrypted) Object.assign(update, {
      plateCiphertext: prismaBytes(plateEncrypted.ciphertext), plateNonce: prismaBytes(plateEncrypted.nonce), plateTag: prismaBytes(plateEncrypted.tag),
      plateEncryptedDek: prismaBytes(plateEncrypted.encryptedDek), plateKeyVersion: plateEncrypted.keyVersion,
      plateAadVersion: plateEncrypted.aadVersion ?? 2, plateHmac: prismaBytes(plateIndex.digest), plateHmacKeyVersion: plateIndex.keyVersion,
    });
    const row = await tx.vehicle.update({ where: { id: mutation.id }, data: update });
    return { row, conflict: false };
  }

  private async decryptVehiclePlate(row: VehicleRow): Promise<string> {
    return this.crypto.decrypt({
      ciphertext: Buffer.from(row.plateCiphertext), nonce: Buffer.from(row.plateNonce), tag: Buffer.from(row.plateTag),
      encryptedDek: Buffer.from(row.plateEncryptedDek), keyVersion: row.plateKeyVersion, aadVersion: row.plateAadVersion,
    }, 'vehicles.plate', row.plateAadVersion === 2 ? { userId: row.userId, recordId: row.id } : undefined);
  }

  private async applyDocumentMutation(
    tx: Prisma.TransactionClient, userId: string, mutation: SyncMutationDto, clientTime: Date,
  ): Promise<{ row: VehicleDocumentRow; conflict: boolean }> {
    const data = mutation.data ?? {};
    const existing = await this.conflictOrOwned(tx, 'vehicle_document', mutation.id, userId);
    if (mutation.operation === 'delete') {
      if (!existing) throw new NotFoundException({ code: 'RESOURCE_NOT_FOUND', message: 'No se encontró el documento.', details: {} });
      if (existing.deletedAt) return { row: existing, conflict: false };
      if (await this.checkLww(existing, clientTime)) return { row: existing, conflict: true };
      if (existing.insurancePolicyId) throw new ConflictException({ code: 'POLICY_DOCUMENT_MANAGED_BY_POLICY', message: 'El documento de una póliza se administra desde la póliza.', details: {} });
      const deletedAt = new Date();
      await this.reminders.cancelForDocument(tx, userId, mutation.id, deletedAt);
      const row = await tx.vehicleDocument.update({ where: { id: mutation.id }, data: { deletedAt } });
      return { row, conflict: false };
    }

    this.assertAllowedKeys(
      data,
      existing
        ? ['document_type', 'title', 'issuer_name', 'valid_from', 'valid_until']
        : ['vehicle_id', 'document_type', 'title', 'issuer_name', 'valid_from', 'valid_until'],
      existing ? [] : ['vehicle_id', 'document_type', 'title'],
    );
    if (existing?.deletedAt) throw new ConflictException({ code: 'RESOURCE_RETIRED', message: 'El documento ya fue eliminado y no puede reactivarse.', details: {} });
    if (existing && await this.checkLww(existing, clientTime)) return { row: existing, conflict: true };
    if (existing?.insurancePolicyId) throw new ConflictException({ code: 'POLICY_DOCUMENT_MANAGED_BY_POLICY', message: 'El documento de una póliza se administra desde la póliza.', details: {} });

    const vehicleId = data.vehicle_id === undefined ? existing?.vehicleId : this.ensureUuid(data.vehicle_id, 'vehicle_id', true)!;
    const vehicle = await tx.vehicle.findFirst({ where: { id: vehicleId, userId, deletedAt: null }, select: { id: true } });
    if (!vehicle) throw new BadRequestException({ code: 'RESOURCE_NOT_OWNED', message: 'El vehículo no pertenece a la cuenta o está eliminado.', details: {} });
    const documentType = data.document_type === undefined ? existing?.documentType : data.document_type;
    if (typeof documentType !== 'string' || !ALLOWED_DOCUMENT_TYPES.has(documentType)) throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'document_type no es válido.', details: {} });
    const title = data.title === undefined ? existing?.title : this.ensureString(data.title, 'title', 1, 120, true);
    const issuerName = data.issuer_name === undefined ? existing?.issuerName ?? null : this.ensureString(data.issuer_name, 'issuer_name', 1, 120);
    const validFrom = data.valid_from === undefined ? existing?.validFrom ?? null : this.ensureDate(data.valid_from, 'valid_from');
    const validUntil = data.valid_until === undefined ? existing?.validUntil ?? null : this.ensureDate(data.valid_until, 'valid_until');
    if (!title) throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'title es obligatorio.', details: {} });
    if (validFrom && validUntil && validUntil <= validFrom) throw new BadRequestException({ code: 'DOCUMENT_VALIDITY_INVALID', message: 'valid_until debe ser posterior a valid_from.', details: {} });

    let row: VehicleDocumentRow;
    if (!existing) {
      row = await tx.vehicleDocument.create({ data: {
        id: mutation.id, userId, vehicleId: vehicleId!, documentType: documentType as VehicleDocumentType,
        title, issuerName, validFrom, validUntil, fileStatus: 'pendiente_subida',
      } });
    } else {
      row = await tx.vehicleDocument.update({ where: { id: mutation.id }, data: {
        ...(data.vehicle_id !== undefined ? { vehicleId: vehicleId! } : {}),
        ...(data.document_type !== undefined ? { documentType: documentType as VehicleDocumentType } : {}),
        ...(data.title !== undefined ? { title } : {}),
        ...(data.issuer_name !== undefined ? { issuerName } : {}),
        ...(data.valid_from !== undefined ? { validFrom } : {}),
        ...(data.valid_until !== undefined ? { validUntil } : {}),
      } });
    }
    await this.reminders.regenerateForDocument(tx, userId, row.id);
    return { row, conflict: false };
  }

  private async applyPolicyMutation(
    tx: Prisma.TransactionClient, userId: string, mutation: SyncMutationDto, clientTime: Date,
  ): Promise<{ row: InsurancePolicyRow; conflict: boolean }> {
    const data = mutation.data ?? {};
    const existing = await this.conflictOrOwned(tx, 'insurance_policy', mutation.id, userId);
    if (mutation.operation === 'delete') {
      if (!existing) throw new NotFoundException({ code: 'RESOURCE_NOT_FOUND', message: 'No se encontró la póliza.', details: {} });
      if (existing.deletedAt) return { row: await tx.insurancePolicy.findFirstOrThrow({ where: { id: mutation.id }, include: { insurer: true, document: true } }), conflict: false };
      if (await this.checkLww(existing, clientTime)) return { row: await tx.insurancePolicy.findFirstOrThrow({ where: { id: mutation.id }, include: { insurer: true, document: true } }), conflict: true };
      const deletedAt = new Date();
      const doc = await tx.vehicleDocument.findUnique({ where: { insurancePolicyId: mutation.id } });
      if (doc) {
        await this.reminders.cancelForDocument(tx, userId, doc.id, deletedAt);
        await tx.vehicleDocument.update({ where: { id: doc.id }, data: { deletedAt } });
      }
      await tx.insurancePolicy.update({ where: { id: mutation.id }, data: { deletedAt, status: 'archived', archivedAt: deletedAt } });
      return { row: await tx.insurancePolicy.findFirstOrThrow({ where: { id: mutation.id }, include: { insurer: true, document: true } }), conflict: false };
    }

    this.assertAllowedKeys(data, [
      'vehicle_id', 'document_id', 'insurer_id', 'other_insurer_name', 'policy_number', 'valid_from', 'valid_until',
      'deductible', 'premium', 'currency', 'claims_phone', 'title',
    ], existing ? [] : ['vehicle_id', 'document_id', 'policy_number', 'valid_from', 'valid_until', 'currency']);
    if (existing?.deletedAt || existing?.status === 'archived') throw new ConflictException({ code: 'POLICY_ARCHIVED_IMMUTABLE', message: 'El historial de pólizas archivadas no se puede modificar.', details: {} });
    if (existing && await this.checkLww(existing, clientTime)) return { row: await tx.insurancePolicy.findFirstOrThrow({ where: { id: mutation.id }, include: { insurer: true, document: true } }), conflict: true };

    const vehicleId = data.vehicle_id === undefined ? existing?.vehicleId : this.ensureUuid(data.vehicle_id, 'vehicle_id', true)!;
    const vehicle = await tx.vehicle.findFirst({ where: { id: vehicleId, userId, deletedAt: null }, select: { id: true } });
    if (!vehicle) throw new BadRequestException({ code: 'RESOURCE_NOT_OWNED', message: 'El vehículo no pertenece a la cuenta o está eliminado.', details: {} });
    const documentId = data.document_id === undefined
      ? (existing ? (await tx.vehicleDocument.findUnique({ where: { insurancePolicyId: mutation.id }, select: { id: true } }))?.id : null)
      : this.ensureUuid(data.document_id, 'document_id', true);
    if (!existing && !documentId) throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'document_id es obligatorio para crear una póliza offline.', details: {} });
    if (!existing && documentId && !isUuidV7(documentId)) {
      throw new BadRequestException({ code: 'ID_INVALID', message: 'document_id debe ser UUID v7.', details: {} });
    }

    const currentInsurerId = existing?.insurerId ?? null;
    const currentOtherInsurer = existing?.otherInsurerName ?? null;
    let insurerId: string | null;
    let otherInsurerName: string | null;
    if (data.insurer_id !== undefined) {
      insurerId = this.ensureUuid(data.insurer_id, 'insurer_id');
      otherInsurerName = data.other_insurer_name === undefined
        ? null : this.ensureString(data.other_insurer_name, 'other_insurer_name', 1, 120);
    } else if (data.other_insurer_name !== undefined) {
      insurerId = null;
      otherInsurerName = this.ensureString(data.other_insurer_name, 'other_insurer_name', 1, 120);
    } else {
      insurerId = currentInsurerId;
      otherInsurerName = currentOtherInsurer;
    }
    if (Boolean(insurerId) === Boolean(otherInsurerName)) throw new BadRequestException({ code: 'INSURER_SELECTION_INVALID', message: 'Selecciona una aseguradora del catálogo o escribe otra, pero no ambas.', details: {} });
    if (insurerId) {
      const insurer = await tx.insurer.findFirst({ where: { id: insurerId, isActive: true }, select: { id: true } });
      if (!insurer) throw new BadRequestException({ code: 'CATALOG_REFERENCE_INVALID', message: 'La aseguradora seleccionada no está disponible.', details: {} });
    }

    const validFrom = data.valid_from === undefined ? existing?.validFrom ?? null : this.ensureDate(data.valid_from, 'valid_from', true);
    const validUntil = data.valid_until === undefined ? existing?.validUntil ?? null : this.ensureDate(data.valid_until, 'valid_until', true);
    if (!validFrom || !validUntil || validUntil <= validFrom) throw new BadRequestException({ code: 'POLICY_VALIDITY_REQUIRED', message: 'La póliza requiere un rango de vigencia válido.', details: {} });
    const currency = data.currency === undefined ? existing?.currency ?? 'USD' : data.currency;
    if (currency !== 'USD' && currency !== 'NIO') throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'currency debe ser USD o NIO.', details: {} });
    const deductible = data.deductible === undefined ? existing?.deductible?.toNumber() ?? null : data.deductible === null ? null : Number(data.deductible);
    const premium = data.premium === undefined ? existing?.premium?.toNumber() ?? null : data.premium === null ? null : Number(data.premium);
    if ((deductible !== null && (!Number.isFinite(deductible) || deductible < 0)) || (premium !== null && (!Number.isFinite(premium) || premium < 0))) {
      throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'deductible y premium deben ser importes no negativos.', details: {} });
    }
    const existingDocument = existing
      ? await tx.vehicleDocument.findUnique({ where: { insurancePolicyId: mutation.id } })
      : null;
    const title = data.title === undefined
      ? existingDocument?.title ?? 'Póliza de seguro'
      : this.ensureString(data.title, 'title', 1, 120, true)!;

    let policyNumberFields: PolicyNumberFields = {};
    if (data.policy_number !== undefined || !existing) {
      const policyNumber = this.ensureString(data.policy_number, 'policy_number', 1, 120, true)!;
      const encrypted = await this.crypto.encrypt(policyNumber, 'insurance_policies.policy_number', { userId, recordId: mutation.id });
      policyNumberFields = {
        policyNumberCiphertext: prismaBytes(encrypted.ciphertext), policyNumberNonce: prismaBytes(encrypted.nonce), policyNumberTag: prismaBytes(encrypted.tag),
        policyNumberEncryptedDek: prismaBytes(encrypted.encryptedDek), policyNumberKeyVersion: encrypted.keyVersion,
        policyNumberAadVersion: encrypted.aadVersion ?? 2,
      };
    }
    let claimsPhoneFields: PolicyClaimsPhoneFields = {};
    if (data.claims_phone !== undefined) {
      if (data.claims_phone === null || data.claims_phone === '') {
        claimsPhoneFields = { claimsPhoneCiphertext: null, claimsPhoneNonce: null, claimsPhoneTag: null, claimsPhoneEncryptedDek: null, claimsPhoneKeyVersion: null, claimsPhoneAadVersion: null };
      } else {
        const phone = this.ensureString(data.claims_phone, 'claims_phone', 8, 20, true)!;
        if (!/^\+?[0-9]{8,19}$/.test(phone)) throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'claims_phone no tiene un formato válido.', details: {} });
        const encrypted = await this.crypto.encrypt(phone, 'insurance_policies.claims_phone', { userId, recordId: mutation.id });
        claimsPhoneFields = { claimsPhoneCiphertext: prismaBytes(encrypted.ciphertext), claimsPhoneNonce: prismaBytes(encrypted.nonce), claimsPhoneTag: prismaBytes(encrypted.tag), claimsPhoneEncryptedDek: prismaBytes(encrypted.encryptedDek), claimsPhoneKeyVersion: encrypted.keyVersion, claimsPhoneAadVersion: encrypted.aadVersion ?? 2 };
      }
    }

    let row: InsurancePolicyRow;
    if (!existing) {
      const previous = await tx.insurancePolicy.findFirst({ where: { userId, vehicleId: vehicleId!, status: 'active', deletedAt: null }, orderBy: { createdAt: 'desc' } });
      if (previous) {
        await tx.insurancePolicy.update({ where: { id: previous.id }, data: { status: 'archived', archivedAt: new Date() } });
        const previousDoc = await tx.vehicleDocument.findUnique({ where: { insurancePolicyId: previous.id }, select: { id: true } });
        if (previousDoc) await this.reminders.cancelForDocument(tx, userId, previousDoc.id);
      }
      row = await tx.insurancePolicy.create({
        data: {
          id: mutation.id, userId, vehicleId: vehicleId!, insurerId, otherInsurerName,
          policyNumberCiphertext: policyNumberFields.policyNumberCiphertext!,
          policyNumberNonce: policyNumberFields.policyNumberNonce!,
          policyNumberTag: policyNumberFields.policyNumberTag!,
          policyNumberEncryptedDek: policyNumberFields.policyNumberEncryptedDek!,
          policyNumberKeyVersion: policyNumberFields.policyNumberKeyVersion!,
          policyNumberAadVersion: policyNumberFields.policyNumberAadVersion!,
          validFrom, validUntil, deductible, premium, currency,
          ...claimsPhoneFields, previousPolicyId: previous?.id ?? null,
          document: { create: {
            id: documentId!, userId, vehicleId: vehicleId!, documentType: 'poliza', title,
            issuerName: otherInsurerName, validFrom, validUntil, fileStatus: 'pendiente_subida',
          } },
        }, include: { insurer: true, document: true },
      });
      if (row.document) await this.reminders.regenerateForDocument(tx, userId, row.document.id);
    } else {
      const actualDocument = existingDocument;
      if (!actualDocument || (documentId && actualDocument.id !== documentId)) throw new ConflictException({ code: 'POLICY_DOCUMENT_MISMATCH', message: 'El documento asociado a la póliza no coincide.', details: {} });
      if (vehicleId !== existing.vehicleId) throw new ConflictException({ code: 'POLICY_VEHICLE_IMMUTABLE', message: 'No se puede cambiar el vehículo de una póliza existente.', details: {} });
      row = await tx.insurancePolicy.update({ where: { id: mutation.id }, data: {
        insurerId, otherInsurerName, ...policyNumberFields, validFrom, validUntil, deductible, premium, currency, ...claimsPhoneFields,
      }, include: { insurer: true, document: true } });
      await tx.vehicleDocument.update({ where: { id: actualDocument.id }, data: {
        title, issuerName: otherInsurerName, validFrom, validUntil,
      } });
      await this.reminders.regenerateForDocument(tx, userId, actualDocument.id);
      row = await tx.insurancePolicy.findFirstOrThrow({ where: { id: mutation.id }, include: { insurer: true, document: true } });
    }
    return { row, conflict: false };
  }

  private async applyPreferenceMutation(
    tx: Prisma.TransactionClient, userId: string, mutation: SyncMutationDto, clientTime: Date,
  ): Promise<{ row: NotificationPreferenceRow; conflict: boolean }> {
    const data = mutation.data ?? {};
    this.assertAllowedKeys(data, ['enabled_offsets', 'preferred_time', 'push_enabled', 'local_enabled', 'in_app_enabled']);
    if (mutation.operation === 'delete') throw new UnprocessableEntityException({ code: 'ENTITY_NOT_SYNCABLE', message: 'La preferencia única de notificaciones no se elimina desde sync/push.', details: {} });
    await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${userId}, 0))`);
    const existing = await tx.notificationPreference.findFirst({ where: { userId, category: 'document_expiry', deletedAt: null } });
    if (existing && existing.id !== mutation.id) throw new ConflictException({ code: 'RESOURCE_NOT_OWNED', message: 'El identificador no corresponde a las preferencias activas de la cuenta.', details: {} });
    if (existing && await this.checkLww(existing, clientTime)) return { row: existing, conflict: true };
    if (!existing && !isUuidV7(mutation.id)) throw new BadRequestException({ code: 'ID_INVALID', message: 'La preferencia nueva requiere UUID v7.', details: {} });

    let offsets = existing?.enabledOffsets ?? [30, 15, 7, 1, 0];
    if (data.enabled_offsets !== undefined) {
      if (!Array.isArray(data.enabled_offsets) || data.enabled_offsets.some((v) => !Number.isInteger(v) || !ALLOWED_OFFSETS.has(v)) || new Set(data.enabled_offsets).size !== data.enabled_offsets.length) {
        throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'enabled_offsets solo admite valores únicos entre 30, 15, 7, 1 y 0.', details: {} });
      }
      offsets = data.enabled_offsets as number[];
    }
    const preferredTime = data.preferred_time === undefined ? existing?.preferredTime ?? '09:00' : this.ensureString(data.preferred_time, 'preferred_time', 5, 5, true)!;
    if (!/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(preferredTime)) throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'preferred_time debe usar HH:mm.', details: {} });
    for (const key of ['push_enabled', 'local_enabled', 'in_app_enabled']) {
      if (data[key] !== undefined && typeof data[key] !== 'boolean') throw new BadRequestException({ code: 'VALIDATION_ERROR', message: `${key} debe ser booleano.`, details: {} });
    }
    const updateData = {
      enabledOffsets: offsets, preferredTime,
      pushEnabled: data.push_enabled === undefined ? existing?.pushEnabled ?? true : data.push_enabled as boolean,
      localEnabled: data.local_enabled === undefined ? existing?.localEnabled ?? true : data.local_enabled as boolean,
      inAppEnabled: data.in_app_enabled === undefined ? existing?.inAppEnabled ?? true : data.in_app_enabled as boolean,
      timezone: 'America/Managua', category: 'document_expiry',
    };
    const row = existing
      ? await tx.notificationPreference.update({ where: { id: existing.id }, data: updateData })
      : await tx.notificationPreference.create({ data: { id: mutation.id, userId, ...updateData } });
    const documents = await tx.vehicleDocument.findMany({ where: { userId, deletedAt: null, validUntil: { not: null } }, select: { id: true } });
    for (const doc of documents) await this.reminders.regenerateForDocument(tx, userId, doc.id, row);
    return { row, conflict: false };
  }

  private async applyEmergencyContactMutation(
    tx: Prisma.TransactionClient, userId: string, mutation: SyncMutationDto, clientTime: Date,
  ): Promise<{ row: EmergencyContactRow; conflict: boolean }> {
    const data = mutation.data ?? {};
    await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${userId}, 0))`);
    const existing = await this.conflictOrOwned(tx, 'emergency_contact', mutation.id, userId);
    if (mutation.operation === 'delete') {
      if (!existing) throw new NotFoundException({ code: 'RESOURCE_NOT_FOUND', message: 'No se encontró el contacto de emergencia.', details: {} });
      if (existing.deletedAt) return { row: existing, conflict: false };
      if (await this.checkLww(existing, clientTime)) return { row: existing, conflict: true };
      const row = await tx.emergencyContact.update({ where: { id: mutation.id }, data: {
        deletedAt: new Date(), isPrimary: false,
        phoneCiphertext: null, phoneNonce: null, phoneTag: null, phoneEncryptedDek: null,
        phoneKeyVersion: null, phoneAadVersion: null, phoneHmac: null, phoneHmacKeyVersion: null,
      } });
      return { row, conflict: false };
    }
    this.assertAllowedKeys(data, ['name', 'relationship_label', 'phone_e164', 'is_primary'], existing ? [] : ['name', 'phone_e164']);
    if (existing?.deletedAt) throw new ConflictException({ code: 'RESOURCE_RETIRED', message: 'El contacto fue eliminado y no puede reactivarse.', details: {} });
    if (existing && await this.checkLww(existing, clientTime)) return { row: existing, conflict: true };
    const name = data.name === undefined ? existing?.name : this.ensureString(data.name, 'name', 1, 120, true)!;
    const relationship = data.relationship_label === undefined ? existing?.relationshipLabel ?? null : this.ensureString(data.relationship_label, 'relationship_label', 1, 40);
    const isPrimary = data.is_primary === undefined ? existing?.isPrimary ?? false : data.is_primary;
    if (typeof isPrimary !== 'boolean') throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'is_primary debe ser booleano.', details: {} });
    let phoneFields: EmergencyContactPhoneFields = {};
    if (data.phone_e164 !== undefined || !existing) {
      const phone = this.ensureString(data.phone_e164, 'phone_e164', 8, 16, true)!.replace(/[\s()-]/g, '');
      if (!/^\+[1-9][0-9]{7,14}$/.test(phone)) throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'phone_e164 debe usar formato internacional E.164.', details: {} });
      const [encrypted, index] = await Promise.all([
        this.crypto.encrypt(phone, 'emergency_contacts.phone', { userId, recordId: mutation.id }),
        this.crypto.blindIndex(phone, 'emergency_contacts.phone'),
      ]);
      phoneFields = {
        phoneCiphertext: prismaBytes(encrypted.ciphertext), phoneNonce: prismaBytes(encrypted.nonce), phoneTag: prismaBytes(encrypted.tag),
        phoneEncryptedDek: prismaBytes(encrypted.encryptedDek), phoneKeyVersion: encrypted.keyVersion,
        phoneAadVersion: encrypted.aadVersion ?? 2, phoneHmac: prismaBytes(index.digest), phoneHmacKeyVersion: index.keyVersion,
      };
    }
    if (isPrimary) await tx.emergencyContact.updateMany({ where: { userId, deletedAt: null, isPrimary: true, id: { not: mutation.id } }, data: { isPrimary: false } });
    let row: EmergencyContactRow;
    if (!existing) {
      const count = await tx.emergencyContact.count({ where: { userId, deletedAt: null } });
      if (count >= 5) throw new ConflictException({ code: 'EMERGENCY_CONTACT_LIMIT_REACHED', message: 'Solo se permiten cinco contactos de emergencia por cuenta.', details: { maximum: 5 } });
      row = await tx.emergencyContact.create({ data: { id: mutation.id, userId, name: name!, relationshipLabel: relationship, isPrimary, ...phoneFields } });
    } else {
      row = await tx.emergencyContact.update({ where: { id: mutation.id }, data: {
        ...(data.name !== undefined ? { name } : {}),
        ...(data.relationship_label !== undefined ? { relationshipLabel: relationship } : {}),
        ...(data.is_primary !== undefined ? { isPrimary } : {}),
        ...phoneFields,
      } });
    }
    return { row, conflict: false };
  }

  private async applyAssistanceRequestMutation(
    tx: Prisma.TransactionClient, userId: string, mutation: SyncMutationDto, clientTime: Date,
  ): Promise<{ row: AssistanceRequestRow; conflict: boolean }> {
    const data = mutation.data ?? {};
    if (mutation.operation === 'delete') {
      // Serializa la cancelación del conductor con las acciones por enlace del proveedor.
      await tx.$queryRaw(Prisma.sql`SELECT id FROM public.assistance_requests WHERE id = ${mutation.id}::uuid AND user_id = ${userId}::uuid FOR UPDATE`);
    }
    const existing = await this.conflictOrOwned(tx, 'assistance_request', mutation.id, userId);
    if (existing?.deletedAt) throw new ConflictException({ code: 'RESOURCE_RETIRED', message: 'La solicitud de asistencia fue retirada y no puede reactivarse.', details: {} });
    if (mutation.operation === 'delete') {
      if (!existing) throw new NotFoundException({ code: 'RESOURCE_NOT_FOUND', message: 'No se encontró la solicitud de asistencia.', details: {} });
      if (existing.status === 'cancelled') return { row: existing, conflict: false };
      if (!['created', 'sent'].includes(existing.status)) throw new ConflictException({ code: 'INVALID_STATE_TRANSITION', message: 'La solicitud ya no se puede cancelar desde el dispositivo.', details: {} });
      if (await this.checkLww(existing, clientTime)) return { row: existing, conflict: true };
      const row = await tx.assistanceRequest.update({ where: { id: mutation.id }, data: { status: 'cancelled', cancelledAt: new Date() } });
      await tx.assistanceRequestEvent.create({ data: { requestId: mutation.id, fromStatus: existing.status, toStatus: 'cancelled', actorType: 'driver', actorUserId: userId } });
      await tx.assistanceActionToken.updateMany({ where: { requestId: mutation.id, usedAt: null }, data: { usedAt: new Date() } });
      return { row, conflict: false };
    }
    this.assertAllowedKeys(data, [
      'vehicle_id', 'service_type_id', 'issue_description', 'address_reference_text', 'latitude', 'longitude',
      'department_id', 'municipality_id', 'contact_phone', 'preferred_contact',
    ], existing ? [] : ['service_type_id', 'issue_description', 'address_reference_text']);
    if (existing && existing.status !== 'created') throw new ConflictException({ code: 'INVALID_STATE_TRANSITION', message: 'La solicitud ya no admite cambios del conductor.', details: {} });
    if (existing && await this.checkLww(existing, clientTime)) return { row: existing, conflict: true };

    const vehicleId = data.vehicle_id === undefined ? existing?.vehicleId ?? null : this.ensureUuid(data.vehicle_id, 'vehicle_id');
    if (!existing) await this.assistanceRateLimit.assertWithinLimit(tx, userId);
    if (!existing || vehicleId !== existing.vehicleId) {
      // Evita duplicar una solicitud activa por vehículo (o por cuenta cuando no se indicó vehículo).
      // El índice parcial en PostgreSQL constituye la última barrera ante escrituras concurrentes.
      await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${userId}, 0))`);
      const duplicate = await tx.assistanceRequest.findFirst({
        where: {
          userId, vehicleId, deletedAt: null, status: { in: ACTIVE_ASSISTANCE_STATES },
          ...(existing ? { id: { not: existing.id } } : {}),
        },
        select: { id: true },
      });
      if (duplicate) throw new ConflictException({
        code: 'ASSISTANCE_ALREADY_SUBMITTED',
        message: 'Ya existe una solicitud de asistencia activa para este vehículo.',
        details: {},
      });
    }
    if (vehicleId) {
      const vehicle = await tx.vehicle.findFirst({ where: { id: vehicleId, userId, deletedAt: null }, select: { id: true } });
      if (!vehicle) throw new BadRequestException({ code: 'RESOURCE_NOT_OWNED', message: 'El vehículo indicado no pertenece a la cuenta o está eliminado.', details: {} });
    }
    const serviceTypeId = data.service_type_id === undefined ? existing?.serviceTypeId : this.ensureUuid(data.service_type_id, 'service_type_id', true)!;
    if (!serviceTypeId) throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'service_type_id es obligatorio.', details: {} });
    if (data.service_type_id !== undefined || !existing) {
      const serviceType = await tx.serviceType.findFirst({ where: { id: serviceTypeId, isActive: true }, select: { id: true } });
      if (!serviceType) throw new BadRequestException({ code: 'CATALOG_REFERENCE_INVALID', message: 'El tipo de servicio no existe o no está disponible.', details: {} });
    }
    const departmentId = data.department_id === undefined ? existing?.departmentId ?? null : this.ensureUuid(data.department_id, 'department_id');
    const municipalityId = data.municipality_id === undefined ? existing?.municipalityId ?? null : this.ensureUuid(data.municipality_id, 'municipality_id');
    if (municipalityId && !departmentId) throw new BadRequestException({ code: 'CATALOG_REFERENCE_INVALID', message: 'Un municipio requiere su departamento.', details: {} });
    if (departmentId) {
      const department = await tx.department.findFirst({ where: { id: departmentId, isActive: true }, select: { id: true } });
      if (!department) throw new BadRequestException({ code: 'CATALOG_REFERENCE_INVALID', message: 'El departamento no está disponible.', details: {} });
    }
    if (municipalityId) {
      if (!departmentId) throw new BadRequestException({ code: 'CATALOG_REFERENCE_INVALID', message: 'Un municipio requiere su departamento.', details: {} });
      const municipality = await tx.municipality.findFirst({ where: { id: municipalityId, departmentId, isActive: true }, select: { id: true } });
      if (!municipality) throw new BadRequestException({ code: 'CATALOG_REFERENCE_INVALID', message: 'El municipio no pertenece al departamento indicado.', details: {} });
    }
    const issueDescription = data.issue_description === undefined ? existing?.issueDescription : this.ensureString(data.issue_description, 'issue_description', 1, 1000, true);
    const addressReference = data.address_reference_text === undefined ? existing?.addressReferenceText : this.ensureString(data.address_reference_text, 'address_reference_text', 1, 300, true);
    if (!issueDescription || !addressReference) throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'La descripción y referencia de ubicación son obligatorias.', details: {} });
    const preferredContact = data.preferred_contact === undefined ? existing?.preferredContact ?? 'whatsapp' : data.preferred_contact;
    if (!['whatsapp', 'call', 'in_app'].includes(String(preferredContact))) throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'preferred_contact no es válido.', details: {} });

    let phoneFields: AssistanceRequestPhoneFields = {};
    if (data.contact_phone !== undefined) {
      if (data.contact_phone === null || data.contact_phone === '') {
        phoneFields = { contactPhoneCiphertext: null, contactPhoneNonce: null, contactPhoneTag: null, contactPhoneEncryptedDek: null, contactPhoneKeyVersion: null, contactPhoneAadVersion: null, contactPhoneHmac: null, contactPhoneHmacKeyVersion: null };
      } else {
        const phone = this.ensureString(data.contact_phone, 'contact_phone', 8, 16, true)!.replace(/[\s()-]/g, '');
        if (!/^\+[1-9][0-9]{7,14}$/.test(phone)) throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'contact_phone debe usar formato E.164.', details: {} });
        const [encrypted, index] = await Promise.all([
          this.crypto.encrypt(phone, 'assistance_requests.contact_phone', { userId, recordId: mutation.id }),
          this.crypto.blindIndex(phone, 'assistance_requests.contact_phone'),
        ]);
        phoneFields = {
          contactPhoneCiphertext: prismaBytes(encrypted.ciphertext), contactPhoneNonce: prismaBytes(encrypted.nonce), contactPhoneTag: prismaBytes(encrypted.tag),
          contactPhoneEncryptedDek: prismaBytes(encrypted.encryptedDek), contactPhoneKeyVersion: encrypted.keyVersion,
          contactPhoneAadVersion: encrypted.aadVersion ?? 2, contactPhoneHmac: prismaBytes(index.digest), contactPhoneHmacKeyVersion: index.keyVersion,
        };
      }
    }
    let coordinates: { latitude: number; longitude: number } | null = null;
    if (data.latitude !== undefined || data.longitude !== undefined) {
      if (data.latitude === null && data.longitude === null) coordinates = null;
      else {
        if (data.latitude === null || data.longitude === null || data.latitude === undefined || data.longitude === undefined) {
          throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'latitude y longitude deben enviarse juntas o ambas ser null.', details: {} });
        }
        if (typeof data.latitude !== 'number' || typeof data.longitude !== 'number') {
          throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'latitude y longitude deben ser números.', details: {} });
        }
        const latitude = data.latitude; const longitude = data.longitude;
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
          throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'Las coordenadas geográficas están fuera de rango.', details: {} });
        }
        coordinates = { latitude, longitude };
      }
    }

    let row: AssistanceRequestRow;
    if (!existing) {
      row = await tx.assistanceRequest.create({ data: {
        id: mutation.id, userId, vehicleId, serviceTypeId, issueDescription, addressReferenceText: addressReference,
        departmentId, municipalityId, preferredContact: preferredContact as string, status: 'created', ...phoneFields,
      } });
      await tx.assistanceRequestEvent.create({ data: { requestId: mutation.id, fromStatus: null, toStatus: 'created', actorType: 'driver', actorUserId: userId } });
    } else {
      row = await tx.assistanceRequest.update({ where: { id: mutation.id }, data: {
        ...(data.vehicle_id !== undefined ? { vehicleId } : {}),
        ...(data.service_type_id !== undefined ? { serviceTypeId } : {}),
        ...(data.issue_description !== undefined ? { issueDescription } : {}),
        ...(data.address_reference_text !== undefined ? { addressReferenceText: addressReference } : {}),
        ...(data.department_id !== undefined || data.municipality_id !== undefined ? { departmentId, municipalityId } : {}),
        ...(data.preferred_contact !== undefined ? { preferredContact: preferredContact as string } : {}),
        ...phoneFields,
      } });
    }
    if (data.latitude !== undefined || data.longitude !== undefined) {
      if (coordinates) {
        await tx.$executeRaw(Prisma.sql`
          UPDATE public.assistance_requests
          SET location = ST_SetSRID(ST_MakePoint(${coordinates.longitude}, ${coordinates.latitude}), 4326)::geography
          WHERE id = ${mutation.id}::uuid AND user_id = ${userId}::uuid
        `);
      } else {
        await tx.$executeRaw(Prisma.sql`
          UPDATE public.assistance_requests SET location = NULL
          WHERE id = ${mutation.id}::uuid AND user_id = ${userId}::uuid
        `);
      }
      row = await tx.assistanceRequest.findFirstOrThrow({ where: { id: mutation.id, userId } });
    }
    return { row, conflict: false };
  }
}
