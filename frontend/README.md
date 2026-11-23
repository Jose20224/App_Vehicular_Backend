# Registro S.A. · Aplicación móvil

Frontend React + TypeScript + Vite, empaquetable con Capacitor para Android/iOS. Se encuentra dentro del repositorio del backend para mantener el proyecto en una sola carpeta. Las 44 plantillas HTML y sus capturas se conservan en `design-reference/`; la aplicación ejecuta componentes React, CSS y dependencias locales, sin Tailwind por CDN ni HTML incrustado.

## Ejecutar en el navegador

Desde esta carpeta:

```powershell
npm ci
npm run dev
```

Abrir `http://localhost:5173`. Vite envía `/api/*` a `http://127.0.0.1:3000`. Debe estar iniciado el backend con PostgreSQL/PostGIS y Redis. Si no está disponible, la aplicación muestra el error de conexión; no inventa datos ni simula una sesión.

Para configurar otro servidor, copiar `.env.example` a `.env.local` y definir `VITE_API_URL` y `VITE_CONSENT_POLICY_VERSION`. La versión de consentimiento debe coincidir con `CONSENT_POLICY_VERSION` del backend. Las variables `VITE_*` son públicas: nunca incluir JWT secrets, contraseñas, claves AWS ni credenciales de base de datos.

Para iniciar el backend, desde la carpeta superior (raíz del repositorio) y con Docker Desktop en contenedores Linux:

```powershell
npm run install:backend
npm run prisma:generate
npm run infra:up
npm run db:migrate
npm run db:seed
npm run dev:backend
```

La configuración del servidor se toma de `backend/.env`. Verificar `http://localhost:3000/health`. La app no reemplaza la infraestructura y nunca se conecta directamente a PostgreSQL, Redis o AWS.

## Android e iOS

`android/` ya está generado. Para una compilación nativa, usar una API HTTPS alcanzable desde el teléfono; `localhost` es el teléfono, no el equipo de desarrollo. Un build nativo sin una URL HTTPS muestra una pantalla de configuración.

```powershell
$env:VITE_API_URL="https://tu-api.example/api/v1"
$env:VITE_CONSENT_POLICY_VERSION="version-configurada-en-el-servidor"
npm run android:sync
npm run android:open
```

Compilar y ejecutar desde Android Studio con su SDK/JDK compatibles con Capacitor 8. Revisar `appId` (`ni.registro.app`) antes de publicar. Para iOS se necesita macOS y Xcode: `npm run ios:add`, `npm run ios:sync` y `npx cap open ios`. No se ha compilado ni firmado un APK/IPA en esta entrega.

Agregar los orígenes de la aplicación al `CORS_ORIGINS` del backend: `https://localhost` para Android y `capacitor://localhost` para iOS. Para desarrollo web, `http://localhost:5173`. Los permisos de ubicación Android ya están declarados y se solicitan al usarlos. Las fuentes y los iconos están empaquetados localmente. Los mapas y servicios externos requieren conexión.

## Funciones implementadas

- Bienvenida, solicitud OTP por WhatsApp/SMS, verificación, consentimiento, renovación concurrente de tokens y cierre de sesión con purga de caché.
- Inicio con estados vacíos reales; crear, consultar, editar y eliminar vehículos con UUID v7 y validación de formularios.
- Documentos y vigencias: registro, edición, solicitud de URL firmada, PUT del archivo y confirmación; descarga por URL firmada. El modo simulado de S3 se identifica y no se presenta como carga exitosa.
- Registrar póliza, consultar vigencias, documento asociado y llamada a siniestros.
- Directorio de talleres: búsqueda, especialidad, abiertos ahora, GPS, lista/mapa, detalle, contacto y envío de reseñas. Conserva el orden de resultados de la API y etiqueta patrocinados.
- Destacados por departamento, vencimiento de anuncios y métricas de impresión/clic. No se sirven anuncios de ejemplo.
- Emergencias: números del catálogo real, contactos SOS, búsqueda de proveedores por GPS, compartir ubicación, crear auxilio, historial, consultar y cancelar solicitudes propias.
- Editar perfil, exportación/eliminación de cuenta, notificaciones y preferencias de recordatorios.
- Revisión del estado de conexión y compatibilidad del dispositivo mediante `/sync/status`.

Los formularios usan los DTO y rutas reales del servidor. La documentación de traspaso antigua abreviaba algunas rutas; aquí el historial de auxilio consume `/assistance-requests/mine` y las acciones de documento usan POST.

## Alcance que falta integrar

Esto es una primera implementación funcional del cliente del conductor, no una certificación de entrega móvil completa:

- Los tokens y datos privados se mantienen en memoria, sin localStorage. Recargar/cerrar la app requiere OTP de nuevo. Se guarda únicamente un UUID de dispositivo y la selección de departamento como preferencias no sensibles.
- El modo offline permite leer datos cargados durante la sesión. Aún no hay almacenamiento persistente cifrado, cola durable de mutaciones `/sync/push`, bootstrap/pull aplicado a una base local ni resolución de conflictos en UI.
- Las plantillas de huella/PIN necesitan un almacén seguro y autenticación nativa. La pantalla de seguridad explica esta condición; no usa un bloqueo visual como sustituto de seguridad.
- Los controles de recordatorios actualizan las preferencias del backend. La entrega push FCM, registro del token nativo y programación de notificaciones del sistema aún requieren integración y credenciales del proyecto Firebase.
- Los portales owner/admin y facturación B2B no están incluidos en las plantillas del conductor ni expuestos a este cliente.
- La integración de producción con el servidor, S3, OTP real y dispositivos físicos debe probarse con la infraestructura disponible.

## Validaciones

```powershell
npm run typecheck
npm run build
npm test
npm run test:e2e
npm audit --audit-level=high
```

Las pruebas de navegador usan contratos HTTP controlados para verificar acceso, formulario de vehículo, orden orgánico/patrocinado, errores de conexión y purga al salir. No sustituyen una prueba contra PostgreSQL/Redis/S3. Playwright usa Chrome instalado; `CHROME_PATH` permite indicar otro ejecutable. `test-results/` contiene las capturas de validación y no se versiona.

## Estructura y decisión técnica

`src/pages` contiene las pantallas; `src/ui.tsx` los componentes y estados comunes; `src/api.ts` el cliente HTTP; `src/session.tsx` la sesión; `src/models.ts` los modelos del contrato; `android` el proyecto Capacitor. Los módulos de mapas, directorio, asistencia y ajustes se cargan por separado.

La arquitectura original mencionaba Flutter como cliente futuro. Para esta conversión se eligió React + Capacitor porque las plantillas suministradas están en HTML/CSS y pueden transformarse en componentes reutilizables conservando el diseño. El backend continúa siendo independiente del framework del cliente.

Se aplicó la guía React del entorno: peticiones independientes en paralelo, estado de sesión central, caché de consultas por cuenta, división de módulos, formularios accesibles, foco de confirmaciones y limpieza de listeners/efectos. La fuente tipada actual es `models.ts`, revisada contra el backend; aún debe completarse OpenAPI antes de sustituirla por generación automática de todas las respuestas.
