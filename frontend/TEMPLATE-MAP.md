# Correspondencia de las plantillas

Las pantallas estáticas se consolidaron en rutas y estados React. No se ejecutan los scripts de las plantillas originales.

| Grupo original | Implementación |
|---|---|
| Bienvenida, ingreso de teléfono, código y consentimiento | `/bienvenida`, `/ingresar`; estados phone/code y consentimiento validado |
| Inicio, mis vehículos vacío, ficha y registro de vehículo | `/inicio`, `/vehiculos/nuevo`, `/vehiculos/:id`, `/vehiculos/:id/editar` |
| Formulario de trámites/documentos y visor | `/vehiculos/:id/documentos/nuevo`, `/documentos/:id`; estados sin archivo, subida y descarga firmada |
| Registro y detalle de póliza/siniestros | `/vehiculos/:id/polizas/nueva`, `/vehiculos/:id/polizas/:policyId` |
| Notificaciones y preferencias de recordatorios | `/notificaciones`, `/recordatorios`; vacío, leída y preferencias reales |
| Directorio lista/mapa y filtros bottom sheet | `/talleres`; controles de búsqueda/filtros y mapa Leaflet |
| Perfil normal/premium, reseñas y escribir reseña | `/talleres/:slug`, `/talleres/:slug/resena`; contenido real del negocio |
| Carrusel, tarjeta patrocinada, pin destacado, banner y por qué veo esto | Destacados en inicio, etiqueta en lista, punto destacado en mapa y explicación desplegable; TTL y métricas de campañas reales |
| Emergencia, lista vacía de proveedores, formulario, tracker e historial | `/asistencia`, `/asistencia/proveedores`, `/asistencia/nueva`, `/asistencia/:id`, `/asistencia/historial` |
| Contactos de emergencia SOS | `/contactos` |
| Perfil y editar cuenta | `/ajustes`, `/ajustes/cuenta` |
| Permisos | `/ajustes/permisos`; ubicación nativa/web y selección explícita de archivos |
| Privacidad, confirmación de eliminación y sesión terminada | `/ajustes/privacidad`; confirmación, llamada DELETE real y purga/redirección |
| Almacenamiento/sincronización, emergencia offline y talleres offline | Banner de red y lectura de caché de sesión; `/ajustes/sincronizacion`. La persistencia offline completa está pendiente y se informa en UI. |
| Huella y PIN | `/ajustes/seguridad`; informa que el almacén seguro/autenticación nativa sigue pendiente |
| Maqueta push | Centro de avisos de backend implementado; entrega push al sistema pendiente de Firebase e integración nativa |
| UI kit, logotipo y demás recursos | Sistema visual compartido en `src/styles.css`; archivos originales conservados en `design-reference/` |

El README especifica las limitaciones: no se afirma que las plantillas de capacidades nativas pendientes ya sean funciones completas.
