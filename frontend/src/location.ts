import { Capacitor } from '@capacitor/core';
import { Geolocation } from '@capacitor/geolocation';
export async function locate() {
  if (Capacitor.isNativePlatform()) {
    const result = await Geolocation.getCurrentPosition({
      enableHighAccuracy: true,
      timeout: 15000,
    });
    return { lat: result.coords.latitude, lng: result.coords.longitude };
  }
  return new Promise<{ lat: number; lng: number }>((resolve, reject) =>
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => reject(new Error('No pudimos obtener tu ubicación. Revisa el permiso de ubicación.')),
      { enableHighAccuracy: true, timeout: 15000 },
    ),
  );
}
