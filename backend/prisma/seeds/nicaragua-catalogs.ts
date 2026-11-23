import { Prisma } from '../../src/generated/prisma/client';
import type { PrismaClient } from '../../src/generated/prisma/client';

/** División político-administrativa basada en fuentes oficiales citadas en docs/catalogs-emergency.md. */
const DEPARTMENTS = [
  { code: 'NS', name: 'Nueva Segovia', type: 'department', municipalities: ['Jalapa', 'Murra', 'El Jícaro', 'San Fernando', 'Mozonte', 'Dipilto', 'Macuelizo', 'Santa María', 'Ocotal', 'Ciudad Antigua', 'Quilalí', 'Wiwilí de Nueva Segovia'] },
  { code: 'JIN', name: 'Jinotega', type: 'department', municipalities: ['Wiwilí de Jinotega', 'El Cuá', 'San José de Bocay', 'Santa María de Pantasma', 'San Rafael del Norte', 'San Sebastián de Yalí', 'La Concordia', 'Jinotega'] },
  { code: 'MAD', name: 'Madriz', type: 'department', municipalities: ['Somoto', 'Totogalpa', 'Telpaneca', 'San Juan del Río Coco', 'Palacagüina', 'Yalagüina', 'San Lucas', 'Las Sabanas', 'San José de Cusmapa'] },
  { code: 'EST', name: 'Estelí', type: 'department', municipalities: ['Pueblo Nuevo', 'Condega', 'Estelí', 'San Juan de Limay', 'La Trinidad', 'San Nicolás'] },
  { code: 'CHI', name: 'Chinandega', type: 'department', municipalities: ['Chinandega', 'El Viejo', 'Puerto Morazán', 'Somotillo', 'Villanueva', 'Chichigalpa', 'Posoltega', 'El Realejo', 'Corinto', 'San Pedro del Norte', 'San Francisco del Norte', 'Santo Tomás del Norte', 'Cinco Pinos'] },
  { code: 'LEO', name: 'León', type: 'department', municipalities: ['Achuapa', 'El Sauce', 'Santa Rosa del Peñón', 'El Jicaral', 'Larreynaga', 'Telica', 'Quezalguaque', 'León', 'La Paz Centro', 'Nagarote'] },
  { code: 'MAT', name: 'Matagalpa', type: 'department', municipalities: ['Rancho Grande', 'Río Blanco', 'El Tuma-La Dalia', 'San Isidro', 'Sébaco', 'Matagalpa', 'San Ramón', 'Muy Muy', 'Esquipulas', 'San Dionisio', 'Terrabona', 'Ciudad Darío', 'Matiguás'] },
  { code: 'BOA', name: 'Boaco', type: 'department', municipalities: ['San José de los Remates', 'Boaco', 'Camoapa', 'Santa Lucía', 'Teustepe', 'San Lorenzo'] },
  { code: 'MGA', name: 'Managua', type: 'department', municipalities: ['San Francisco Libre', 'Tipitapa', 'Mateare', 'Villa El Carmen', 'Ciudad Sandino', 'Managua', 'Ticuantepe', 'El Crucero', 'San Rafael del Sur'] },
  { code: 'MAS', name: 'Masaya', type: 'department', municipalities: ['Nindirí', 'Masaya', 'Tisma', 'La Concepción', 'Masatepe', 'Nandasmo', 'Catarina', 'San Juan de Oriente', 'Niquinohomo'] },
  { code: 'CHO', name: 'Chontales', type: 'department', municipalities: ['Comalapa', 'San Francisco de Cuapa', 'Juigalpa', 'La Libertad', 'Santo Domingo', 'Santo Tomás', 'San Pedro de Lóvago', 'Acoyapa', 'Villa Sandino', 'El Coral'] },
  { code: 'GRA', name: 'Granada', type: 'department', municipalities: ['Diriá', 'Diriomo', 'Granada', 'Nandaime'] },
  { code: 'CAR', name: 'Carazo', type: 'department', municipalities: ['San Marcos', 'Diriamba', 'Dolores', 'Jinotepe', 'El Rosario', 'La Paz de Carazo', 'Santa Teresa', 'La Conquista'] },
  { code: 'RIV', name: 'Rivas', type: 'department', municipalities: ['Tola', 'Belén', 'Potosí', 'Buenos Aires', 'Moyogalpa', 'Altagracia', 'San Jorge', 'Rivas', 'San Juan del Sur', 'Cárdenas'] },
  { code: 'RSJ', name: 'Río San Juan', type: 'department', municipalities: ['Morrito', 'El Almendro', 'San Miguelito', 'San Carlos', 'El Castillo', 'San Juan de Nicaragua'] },
  { code: 'RACCN', name: 'Región Autónoma de la Costa Caribe Norte', type: 'autonomous_region', municipalities: ['Puerto Cabezas', 'Waspán', 'Prinzapolka', 'Siuna', 'Rosita', 'Bonanza', 'Mulukukú', 'Waslala'] },
  { code: 'RACCS', name: 'Región Autónoma de la Costa Caribe Sur', type: 'autonomous_region', municipalities: ['Bluefields', 'Corn Island', 'La Cruz de Río Grande', 'Desembocadura de Río Grande', 'El Ayote', 'El Rama', 'El Tortuguero', 'Kukrahill', 'Laguna de Perlas', 'Muelle de los Bueyes', 'Nueva Guinea', 'Paiwas'] },
] as const;

const SERVICE_TYPES = [
  ['grua', 'Grúa', 'Traslado de vehículos averiados o inmovilizados.', true],
  ['cerrajeria_vial', 'Cerrajería vial', 'Apertura o asistencia con llaves del vehículo.', true],
  ['cambio_neumaticos', 'Cambio de neumáticos', 'Cambio de llanta o asistencia por pinchazo.', true],
  ['asistencia_medica_basica', 'Asistencia médica básica', 'Primera asistencia; no sustituye servicios de emergencia médica.', true],
  ['combustible', 'Combustible', 'Suministro de combustible en carretera.', false],
  ['otro', 'Otro', 'Otro tipo de asistencia vial.', false],
] as const;

const SPECIALTIES = [
  ['mecanica_general', 'Mecánica general', 'Mantenimiento y reparación mecánica.'],
  ['mecanica_motocicletas', 'Mecánica de motocicletas', 'Diagnóstico y reparación de motocicletas.'],
  ['electricidad_automotriz', 'Electricidad automotriz', 'Sistemas eléctricos y electrónicos.'],
  ['frenos', 'Frenos', 'Inspección y reparación de frenos.'],
  ['llantas_neumaticos', 'Llantas y neumáticos', 'Llantas, neumáticos y balanceo.'],
  ['transmision', 'Transmisión', 'Sistemas de transmisión y embrague.'],
  ['suspension_direccion', 'Suspensión y dirección', 'Suspensión, amortiguación y dirección.'],
  ['carroceria_pintura', 'Carrocería y pintura', 'Reparación exterior y pintura.'],
  ['aire_acondicionado', 'Aire acondicionado', 'Climatización automotriz.'],
  ['diagnostico', 'Diagnóstico vehicular', 'Escaneo y diagnóstico de fallas.'],
] as const;

function slug(value: string): string {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export async function seedNicaraguaCatalogs(prisma: PrismaClient): Promise<void> {
  let municipalityCount = 0;
  for (const [departmentIndex, department] of DEPARTMENTS.entries()) {
    await prisma.$executeRaw(Prisma.sql`
      INSERT INTO public.departments (code, name, administrative_type, is_active, sort_order)
      VALUES (${department.code}, ${department.name}, ${department.type}, TRUE, ${departmentIndex + 1})
      ON CONFLICT (code) DO UPDATE SET
        name = EXCLUDED.name, administrative_type = EXCLUDED.administrative_type,
        is_active = TRUE, sort_order = EXCLUDED.sort_order, updated_at = clock_timestamp()
      WHERE public.departments.name IS DISTINCT FROM EXCLUDED.name
        OR public.departments.administrative_type IS DISTINCT FROM EXCLUDED.administrative_type
        OR public.departments.is_active IS DISTINCT FROM TRUE
        OR public.departments.sort_order IS DISTINCT FROM EXCLUDED.sort_order
    `);
    const persistedDepartment = await prisma.department.findUnique({ where: { code: department.code }, select: { id: true } });
    if (!persistedDepartment) throw new Error(`No se pudo crear el departamento ${department.name}.`);

    for (const [municipalityIndex, municipality] of department.municipalities.entries()) {
      const code = `${department.code}-${slug(municipality)}`;
      await prisma.$executeRaw(Prisma.sql`
        INSERT INTO public.municipalities (department_id, code, name, is_active, sort_order)
        VALUES (${persistedDepartment.id}::uuid, ${code}, ${municipality}, TRUE, ${municipalityIndex + 1})
        ON CONFLICT (code) DO UPDATE SET
          department_id = EXCLUDED.department_id, name = EXCLUDED.name,
          is_active = TRUE, sort_order = EXCLUDED.sort_order, updated_at = clock_timestamp()
        WHERE public.municipalities.department_id IS DISTINCT FROM EXCLUDED.department_id
          OR public.municipalities.name IS DISTINCT FROM EXCLUDED.name
          OR public.municipalities.is_active IS DISTINCT FROM TRUE
          OR public.municipalities.sort_order IS DISTINCT FROM EXCLUDED.sort_order
      `);
      municipalityCount += 1;
    }
  }

  for (const [index, [code, name, description, isEmergency]] of SERVICE_TYPES.entries()) {
    await prisma.$executeRaw(Prisma.sql`
      INSERT INTO public.service_types (code, name, description, is_emergency, is_active, sort_order)
      VALUES (${code}, ${name}, ${description}, ${isEmergency}, TRUE, ${index + 1})
      ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description,
        is_emergency = EXCLUDED.is_emergency, is_active = TRUE, sort_order = EXCLUDED.sort_order,
        updated_at = clock_timestamp()
      WHERE public.service_types.name IS DISTINCT FROM EXCLUDED.name
        OR public.service_types.description IS DISTINCT FROM EXCLUDED.description
        OR public.service_types.is_emergency IS DISTINCT FROM EXCLUDED.is_emergency
        OR public.service_types.is_active IS DISTINCT FROM TRUE
        OR public.service_types.sort_order IS DISTINCT FROM EXCLUDED.sort_order
    `);
  }

  for (const [index, [code, name, description]] of SPECIALTIES.entries()) {
    await prisma.$executeRaw(Prisma.sql`
      INSERT INTO public.specialties (code, name, description, is_active, sort_order)
      VALUES (${code}, ${name}, ${description}, TRUE, ${index + 1})
      ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description,
        is_active = TRUE, sort_order = EXCLUDED.sort_order, updated_at = clock_timestamp()
      WHERE public.specialties.name IS DISTINCT FROM EXCLUDED.name
        OR public.specialties.description IS DISTINCT FROM EXCLUDED.description
        OR public.specialties.is_active IS DISTINCT FROM TRUE
        OR public.specialties.sort_order IS DISTINCT FROM EXCLUDED.sort_order
    `);
  }

  if (municipalityCount !== 153) throw new Error(`Se esperaban 153 municipios y se definieron ${municipalityCount}.`);
  console.info(`Catálogos B5 aplicados: ${DEPARTMENTS.length} departamentos/regiones, ${municipalityCount} municipios, ${SERVICE_TYPES.length} tipos de servicio y ${SPECIALTIES.length} especialidades.`);
  console.info('No se sembraron teléfonos de emergencia: cada número debe recibirse y verificarse contra una fuente oficial antes de publicarse.');
}
