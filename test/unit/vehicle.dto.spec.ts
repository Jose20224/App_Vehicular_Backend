import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateVehicleDto } from '../../src/modules/vehicles/dto/create-vehicle.dto';
import { UpdateVehicleDto } from '../../src/modules/vehicles/dto/update-vehicle.dto';
import { VehiclePhotoUploadDto } from '../../src/modules/vehicles/dto/vehicle-photo-upload.dto';

const BASE_CREATE = {
  id: '018bcfe5-6800-7abc-8def-0123456789ab',
  plate: 'M 123456',
  brand: ' Toyota ',
  model: ' Corolla ',
  model_year: 2022,
  vehicle_type: 'automobile',
};

describe('Vehicle DTO validation', () => {
  it('normaliza placa y elimina espacios de marca/modelo', async () => {
    const dto = plainToInstance(CreateVehicleDto, BASE_CREATE);
    expect(dto.plate).toBe('M123456');
    expect(dto.brand).toBe('Toyota');
    expect(dto.model).toBe('Corolla');
    await expect(validate(dto)).resolves.toHaveLength(0);
  });

  it('rechaza identificadores que no sean UUID v7', async () => {
    const dto = plainToInstance(CreateVehicleDto, { ...BASE_CREATE, id: '10000000-0000-4000-8000-000000000001' });
    const errors = await validate(dto);
    expect(errors.some((error) => error.property === 'id')).toBe(true);
  });

  it('rechaza año anterior a 1950, posterior al año actual de Managua + 1 y tipo desconocido', async () => {
    const beforeMinimum = plainToInstance(CreateVehicleDto, { ...BASE_CREATE, model_year: 1949 });
    const afterMaximum = plainToInstance(CreateVehicleDto, { ...BASE_CREATE, model_year: 9999 });
    const invalidType = plainToInstance(CreateVehicleDto, { ...BASE_CREATE, vehicle_type: 'scooter_unknown' });

    expect((await validate(beforeMinimum)).some((error) => error.property === 'model_year')).toBe(true);
    expect((await validate(afterMaximum)).some((error) => error.property === 'model_year')).toBe(true);
    expect((await validate(invalidType)).some((error) => error.property === 'vehicle_type')).toBe(true);
  });

  it('no permite valores nulos en campos obligatorios del PATCH', async () => {
    const dto = plainToInstance(UpdateVehicleDto, { plate: null, brand: null, model_year: null, vehicle_type: null });
    const errors = await validate(dto);
    expect(errors.map((error) => error.property)).toEqual(expect.arrayContaining([
      'plate', 'brand', 'model_year', 'vehicle_type',
    ]));
  });

  it('solo acepta fotos JPEG, PNG o WebP y requiere un mínimo de 1 KiB', async () => {
    const invalidMime = plainToInstance(VehiclePhotoUploadDto, { content_type: 'image/gif', size_bytes: 2048 });
    const tooSmall = plainToInstance(VehiclePhotoUploadDto, { content_type: 'image/jpeg', size_bytes: 512 });
    const valid = plainToInstance(VehiclePhotoUploadDto, { content_type: 'image/webp', size_bytes: 2048 });

    expect((await validate(invalidMime)).some((error) => error.property === 'content_type')).toBe(true);
    expect((await validate(tooSmall)).some((error) => error.property === 'size_bytes')).toBe(true);
    await expect(validate(valid)).resolves.toHaveLength(0);
  });
});
