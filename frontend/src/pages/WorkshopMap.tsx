import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { Workshop } from '../models';
export default function WorkshopMap({ items }: { items: Workshop[] }) {
  const node = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!node.current) return;
    const map = L.map(node.current).setView([12.1364, -86.2514], 12);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors',
      maxZoom: 19,
    }).addTo(map);
    const points: L.LatLngExpression[] = [];
    for (const item of items) {
      if (item.latitude == null || item.longitude == null) continue;
      const point: L.LatLngExpression = [item.latitude, item.longitude];
      points.push(point);
      const text = document.createElement('a');
      text.textContent = `${item.name}${item.sponsored || item.patrocinado ? ' · Patrocinado' : ''}`;
      text.href = `#/talleres/${encodeURIComponent(item.slug)}`;
      L.circleMarker(point, {
        radius: item.sponsored ? 13 : 9,
        color: '#1d4ed8',
        fillColor: item.sponsored ? '#f59e0b' : '#1d4ed8',
        fillOpacity: 0.9,
      })
        .addTo(map)
        .bindPopup(text);
    }
    if (points.length) map.fitBounds(L.latLngBounds(points), { padding: [35, 35], maxZoom: 15 });
    return () => {
      map.remove();
    };
  }, [items]);
  return (
    <>
      <div className="map" ref={node} aria-label="Mapa de talleres" />
      <p className="fine">El mapa requiere internet. Selecciona un punto para abrir el taller.</p>
    </>
  );
}
