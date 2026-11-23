import { registerDecorator, type ValidationOptions } from 'class-validator';

function currentYearInManagua(): number {
  return Number(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Managua',
    year: 'numeric',
  }).format(new Date()));
}

/** Valida dinámicamente hasta el año actual en Managua + 1. */
export function MaxCurrentVehicleYear(validationOptions?: ValidationOptions): PropertyDecorator {
  return (target: object, propertyName: string | symbol) => {
    registerDecorator({
      name: 'maxCurrentVehicleYear',
      target: target.constructor,
      propertyName: String(propertyName),
      options: validationOptions,
      validator: {
        validate(value: unknown): boolean {
          return typeof value === 'number' && Number.isInteger(value)
            && value <= currentYearInManagua() + 1;
        },
        defaultMessage(): string {
          return `model_year no puede superar ${currentYearInManagua() + 1}.`;
        },
      },
    });
  };
}
