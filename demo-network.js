// demo-network.js — petit réseau de démonstration (à remplacer par les vraies données)

function buildDemoNetwork() {
  const net = new Network({ id: 'demo', name: 'Réseau régional (démo)', region: 'Démo' });
  const prov = net.addProvider(new Provider({ id: 'p1', name: 'Cars Démo' }));

  const stop = (id, name, city, lat, lon) => new Stop({ id, name, city, lat, lon });
  const aix = stop('aix', 'Gare routière', 'Aix-en-Provence', 43.5263, 5.4545);
  const plan = stop('plan', 'Plan de Campagne', 'Cabriès', 43.4466, 5.3609);
  const mrs = stop('mrs', 'Gare Saint-Charles', 'Marseille', 43.3028, 5.3806);
  const salon = stop('salon', 'Gare SNCF', 'Salon-de-Provence', 43.6429, 5.0975);
  const gard = stop('gard', 'Centre', 'Gardanne', 43.4547, 5.4695);

  const l12 = net.addService(new Service({
    id: 's12', code: 'L12', name: 'Aix – Marseille', mode: 'car',
    provider: prov, operatingPeriods: ['ta', 'x']
  }));
  l12.addStop(aix, { departure: '07:00' });
  l12.addStop(plan, { arrival: '07:20', departure: '07:22' });
  l12.addStop(mrs, { arrival: '07:50' });

  const l20 = net.addService(new Service({
    id: 's20', code: 'L20', name: 'Salon – Gardanne', mode: 'bus',
    provider: prov, operatingPeriods: ['ta']
  }));
  l20.addStop(salon, { departure: '08:10' });
  l20.addStop(aix, { arrival: '08:45', departure: '08:50' });
  l20.addStop(gard, { arrival: '09:10' });

  net.addTariff(new Tariff({ code: '1BUTP', name: 'Billet unité', audience: 'Tout public',
    pricing: { type: 'zones', prices: [2, 3, 3, 4, 5] }, validityMinutes: 90, crossway: true }));
  net.addTariff(new Tariff({ code: '1BUJ', name: 'Billet unité', audience: 'Moins de 26 ans',
    pricing: { type: 'fixed', price: 1.5 }, validityMinutes: 90, crossway: false }));
  l12.tariffCodes = ['1BUTP', '1BUJ'];
  l20.tariffCodes = ['1BUTP'];

  net.addZone(new Zone({ id: 'Z1', name: 'Pays d’Aix' }));
  net.addZone(new Zone({ id: 'Z2', name: 'Marseille' }));
  [aix, plan, salon, gard].forEach(s => { s.zoneId = 'Z1'; });
  mrs.zoneId = 'Z2';

  [aix, plan, mrs, salon, gard].forEach(s => net.addStop(s));

  return net;
}

window.buildDemoNetwork = buildDemoNetwork;
