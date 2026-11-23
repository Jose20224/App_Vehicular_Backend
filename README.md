# App Vehicular · Registro S.A.

Repositorio único para la API NestJS y la aplicación móvil React/Capacitor. La carpeta principal conserva su nombre y ubicación.

```text
App_Vehicular_Backend/
├── backend/             # NestJS, Prisma, migraciones, tests y Dockerfile
│   ├── src/
│   ├── prisma/
│   ├── test/
│   ├── scripts/
│   └── .env.example
├── frontend/            # React, TypeScript, Capacitor y Android
├── docs/                # Arquitectura y contratos compartidos
├── deploy/              # Backups y configuración operativa
├── scripts/             # Despliegue del repositorio completo
├── .github/workflows/   # CI de ambas aplicaciones y despliegue
├── docker-compose.yml
└── package.json         # Comandos de coordinación
```

Cada aplicación mantiene su propio `package.json`, lockfile y dependencias. Los comandos de la raíz delegan a esas aplicaciones. `.git` permanece en la raíz. Los logs anteriores se conservaron en `backend/artifacts/validation/`, ignorados por Git.

## Preparación

Desde esta carpeta, con Node 22.16+ y Docker Desktop en modo Linux:

```powershell
npm run install:all
# Solo si backend/.env no existe:
Copy-Item backend/.env.example backend/.env
npm run prisma:generate
npm run infra:up
npm run db:migrate
npm run db:seed
```

`backend/.env` es la configuración del servidor y Compose. `frontend/.env.local` es opcional y solo contiene variables públicas `VITE_*`. No copiar secretos del backend al frontend.

## Ejecutar

En una terminal desde la raíz: `npm run dev:backend`.

En otra terminal desde la raíz: `npm run dev:frontend`.

- API: `http://localhost:3000/api/v1`
- Salud: `http://localhost:3000/health`
- Swagger: `http://localhost:3000/docs`
- Frontend: `http://localhost:5173`

El proxy Vite apunta al puerto 3000. Revisar servicios con `npm run infra:status`. Al ejecutar Compose directamente desde la raíz, usar siempre `docker compose --env-file backend/.env ...` para cargar los parámetros configurados.

## Validaciones

```powershell
npm run lint
npm run build:backend
npm run test:backend
npm --prefix backend run test:migrations
npm --prefix frontend run typecheck
npm run build:frontend
npm run test:frontend
npm --prefix frontend run test:e2e
```

E2E y migraciones del backend necesitan Docker. Las pruebas del frontend usan respuestas HTTP controladas y no acreditan infraestructura real.

La imagen de la API se construye con `docker build --tag vehicular-api:ci ./backend`. Compose y los workflows utilizan ese contexto. El despliegue remoto usa `scripts/deploy-compose.sh` y requiere `backend/.env` en el host. Se mantienen los nombres de los volúmenes de PostgreSQL/Redis; no se borraron volúmenes.

## Documentación

- [API y dominios](backend/README.md)
- [Frontend y Android](frontend/README.md)
- [Mapa de plantillas](frontend/TEMPLATE-MAP.md)
- [Arquitectura y contratos](docs/README.md)
- [Despliegue y operación](docs/b12-deployment-security-handover.md)

Antes de producción, validar Docker, migraciones, `/health`, OTP/S3 y dispositivo físico. La reorganización por sí sola no acredita esas integraciones.
