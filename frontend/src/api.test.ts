import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, getTokens, onSessionExpired, setTokens, uploadDocument } from './api';
const token = { access_token: 'test-access', refresh_token: 'test-refresh', expires_in: 900 };
function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
describe('API session and errors', () => {
  beforeEach(() => {
    setTokens(token);
    onSessionExpired(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    setTokens(null);
  });
  it('sends bearer credentials and JSON only to the API', async () => {
    const fetch = vi.fn().mockResolvedValue(response({ id: 'vehicle' }));
    vi.stubGlobal('fetch', fetch);
    await api('/vehicles', { method: 'POST', body: { plate: 'M1234' } });
    expect(fetch.mock.calls[0][1]).toMatchObject({
      method: 'POST',
      headers: { Authorization: 'Bearer test-access', 'Content-Type': 'application/json' },
      body: '{"plate":"M1234"}',
    });
  });
  it('does not attach bearer tokens to public OTP requests', async () => {
    const fetch = vi.fn().mockResolvedValue(response({}));
    vi.stubGlobal('fetch', fetch);
    await api('/auth/otp/request', { public: true });
    expect(fetch.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });
  it('shares one refresh for concurrent expired requests', async () => {
    let refreshes = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        if (url.endsWith('/auth/refresh')) {
          refreshes++;
          await new Promise((r) => setTimeout(r, 10));
          return response({ ...token, access_token: 'fresh' });
        }
        if ((init.headers as Record<string, string>).Authorization === 'Bearer test-access')
          return response({ code: 'AUTH_REQUIRED' }, 401);
        return response({ ok: true });
      }),
    );
    const data = await Promise.all([api('/me'), api('/vehicles')]);
    expect(data).toEqual([{ ok: true }, { ok: true }]);
    expect(refreshes).toBe(1);
  });
  it('purges a remotely deleted session', async () => {
    const expired = vi.fn();
    onSessionExpired(expired);
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          response({ code: 'LOCAL_DATA_PURGE_REQUIRED', message: 'Borra tus datos.' }, 403),
        ),
    );
    await expect(api('/me')).rejects.toMatchObject({ code: 'LOCAL_DATA_PURGE_REQUIRED' });
    expect(getTokens()).toBeNull();
    expect(expired).toHaveBeenCalledOnce();
  });
  it('retains domain error and request id', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        response(
          {
            code: 'PLATE_ALREADY_REGISTERED',
            message: 'Placa duplicada',
            request_id: 'req_test',
          },
          409,
        ),
      ),
    );
    await expect(api('/vehicles', { method: 'POST', body: {} })).rejects.toMatchObject({
      status: 409,
      code: 'PLATE_ALREADY_REGISTERED',
      requestId: 'req_test',
    });
  });
  it('does not retry a mutation after a network failure', async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError('network'));
    vi.stubGlobal('fetch', fetch);
    await expect(api('/vehicles', { method: 'POST', body: {} })).rejects.toBeInstanceOf(ApiError);
    expect(fetch).toHaveBeenCalledOnce();
  });
});
describe('signed document upload', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setTokens(null);
  });
  it('does not upload to simulated storage', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(response({ simulated: true, upload_url: 'https://storage.invalid/key' }));
    vi.stubGlobal('fetch', fetch);
    await expect(
      uploadDocument('doc', new File(['%PDF'], 'file.pdf', { type: 'application/pdf' })),
    ).rejects.toThrow('modo simulado');
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('sends the file to S3 without bearer credentials and confirms after PUT', async () => {
    setTokens(token);
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          upload_url: 'https://storage.invalid/key',
          required_headers: { 'x-custom': 'signed' },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(response({ file_status: 'disponible' }));
    vi.stubGlobal('fetch', fetch);
    await uploadDocument('doc', new File(['%PDF'], 'file.pdf', { type: 'application/pdf' }));
    expect(fetch.mock.calls[1][0]).toBe('https://storage.invalid/key');
    expect(fetch.mock.calls[1][1].headers).toEqual({
      'Content-Type': 'application/pdf',
      'x-custom': 'signed',
    });
    expect(fetch.mock.calls[2][0]).toContain('/documents/doc/confirm');
  });
  it('rejects unsupported formats before creating an upload order', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(
      uploadDocument('doc', new File(['abc'], 'file.webp', { type: 'image/webp' })),
    ).rejects.toThrow('Solo se aceptan');
    expect(fetch).not.toHaveBeenCalled();
  });
});
