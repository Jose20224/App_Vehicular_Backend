import { useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { Capacitor } from '@capacitor/core';
import { api, deviceId } from '../api';
import { useSession } from '../session';
import { ErrorNotice, Icon, Submit, useAction } from '../ui';
import type { Profile, Tokens } from '../models';
export function Welcome() {
  const { user } = useSession();
  if (user) return <Navigate to="/inicio" replace />;
  return (
    <main className="welcome">
      <div className="welcome-brand">
        <span className="brand-mark">
          <Icon name="shield" size={36} />
        </span>
        <strong>Registro S.A.</strong>
      </div>
      <span className="eyebrow">HECHO PARA NICARAGUA</span>
      <h1>
        Tu auto,
        <br />
        siempre al día<span>.</span>
      </h1>
      <p className="lead">
        Tus documentos, tus recordatorios y la ayuda que necesitas. Todo en un solo lugar.
      </p>
      <div className="welcome-illustration" aria-hidden="true">
        <div className="orbit orbit-one" />
        <div className="orbit orbit-two" />
        <Icon name="car" size={130} />
        <span className="float-label">
          <Icon name="check" size={16} />
          Todo bajo control
        </span>
      </div>
      <div className="feature-list">
        {[
          ['shield', 'Documentos y pólizas', 'Tus fechas importantes, siempre a mano.'],
          ['workshop', 'Talleres cerca de ti', 'Encuentra y contacta negocios verificados.'],
          ['help', 'Ayuda en carretera', 'Solicita asistencia cuando la necesites.'],
        ].map(([icon, title, subtitle]) => (
          <div className="row" key={title}>
            <span className="tile-icon">
              <Icon name={icon as 'shield'} />
            </span>
            <div>
              <strong>{title}</strong>
              <small>{subtitle}</small>
            </div>
          </div>
        ))}
      </div>
      <Link className="button full" to="/ingresar">
        Comenzar
        <Icon name="arrow" size={20} />
      </Link>
      <p className="fine center">Sin pagos dentro de la app para conductores.</p>
    </main>
  );
}
export function Login() {
  const session = useSession();
  const navigate = useNavigate();
  const action = useAction();
  const [step, setStep] = useState<'phone' | 'code'>('phone');
  const [phone, setPhone] = useState('');
  const [channel, setChannel] = useState('whatsapp');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [consent, setConsent] = useState(false);
  const [debug, setDebug] = useState<string>();
  if (session.user) return <Navigate to="/inicio" replace />;
  return (
    <main className="auth-screen">
      <Link to="/bienvenida" className="icon-button" aria-label="Volver">
        <Icon name="back" />
      </Link>
      <span className="auth-symbol">
        <Icon name={step === 'phone' ? 'shield' : 'check'} size={36} />
      </span>
      <p className="eyebrow">TU ESPACIO, TU TRANQUILIDAD</p>
      <h1>{step === 'phone' ? 'Comencemos con tu número' : 'Confirma que eres tú'}</h1>
      <p className="muted">
        {step === 'phone'
          ? 'Te enviaremos un código para acceder de forma segura.'
          : `Ingresa el código enviado a +505 ${phone}.`}
      </p>
      <ErrorNotice error={action.error} />
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          void action.run(async () => {
            if (step === 'phone') {
              const result = await api<{ debug_code?: string }>('/auth/otp/request', {
                method: 'POST',
                public: true,
                body: { phone: `+505${phone}`, channel },
              });
              setDebug(result.debug_code);
              setStep('code');
            } else {
              const result = await api<{ tokens: Tokens; user: Profile }>('/auth/otp/verify', {
                method: 'POST',
                public: true,
                body: {
                  phone: `+505${phone}`,
                  code,
                  device_id: deviceId(),
                  platform:
                    Capacitor.getPlatform() === 'ios'
                      ? 'ios'
                      : import.meta.env.VITE_PLATFORM || 'android',
                  app_version: '0.1.0',
                  ...(name ? { display_name: name } : {}),
                  consent: {
                    accepted: consent,
                    policy_version:
                      import.meta.env.VITE_CONSENT_POLICY_VERSION || 'privacy-local-v1',
                  },
                },
              });
              session.login(result.tokens, result.user);
              navigate('/inicio', { replace: true });
            }
          });
        }}
      >
        {step === 'phone' ? (
          <>
            <label>
              Número de teléfono
              <div className="phone-input">
                <span>🇳🇮 +505</span>
                <input
                  autoComplete="tel-national"
                  inputMode="numeric"
                  pattern="[0-9]{8}"
                  minLength={8}
                  maxLength={8}
                  required
                  value={phone}
                  onChange={(e) => setPhone(e.target.value.replace(/\D/g, ''))}
                  placeholder="8888 1234"
                  aria-label="Ocho dígitos de tu teléfono"
                />
              </div>
            </label>
            <label>
              Enviar código por
              <select value={channel} onChange={(e) => setChannel(e.target.value)}>
                <option value="whatsapp">WhatsApp</option>
                <option value="sms">SMS</option>
              </select>
            </label>
          </>
        ) : (
          <>
            <label>
              Código de verificación
              <input
                className="otp"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{4,10}"
                required
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="000000"
              />
            </label>
            {debug && (
              <p className="notice">
                Entorno de desarrollo: código {debug}. No se envió un mensaje real.
              </p>
            )}
            <label>
              ¿Cómo te llamas? <span className="fine">(opcional)</span>
              <input
                value={name}
                maxLength={120}
                onChange={(e) => setName(e.target.value)}
                autoComplete="name"
                placeholder="Tu nombre"
              />
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
                required
              />
              <span>
                Acepto el tratamiento de mis datos para gestionar mi cuenta, documentos y
                asistencia.{' '}
                <details>
                  <summary>Ver información de privacidad</summary>
                  <p>
                    Los datos se usan para prestar el servicio. Puedes solicitar su exportación o
                    eliminación desde Mi cuenta. La aceptación se registra con la versión{' '}
                    {import.meta.env.VITE_CONSENT_POLICY_VERSION || 'privacy-local-v1'}.
                  </p>
                </details>
              </span>
            </label>
          </>
        )}
        <Submit pending={action.pending}>
          {step === 'phone' ? 'Enviar código' : 'Verificar y continuar'}
          <Icon name="arrow" size={18} />
        </Submit>
        {step === 'code' && (
          <button
            type="button"
            className="text-button"
            onClick={() => {
              setStep('phone');
              setCode('');
            }}
          >
            Cambiar número o reenviar código
          </button>
        )}
      </form>
      <div className="secure-note">
        <Icon name="shield" size={18} />
        <p>No compartas tu código. Nunca te lo pediremos por llamada.</p>
      </div>
    </main>
  );
}
