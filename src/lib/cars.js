// Jeu de données du comparateur « VEYVRO Battle » — repris de la production existante.
export const BATTLE_CARS = [
  { id: 'm3', name: 'BMW M3 Competition xDrive', price: '~€108,000', priceNumber: 108, power: '530 hp', powerNumber: 530, torque: '650 Nm', torqueNumber: 650, acceleration: '3.5 sec', accelerationNumber: 3.5, topSpeed: '250 km/h', topSpeedNumber: 250, weight: '1,855 kg', weightNumber: 1855, engine: '3.0L twin-turbo inline-6', fuel: 'Petrol', drivetrain: 'AWD' },
  { id: 'rs5', name: 'Audi RS 5 Sportback', price: '~€105,000', priceNumber: 105, power: '450 hp', powerNumber: 450, torque: '600 Nm', torqueNumber: 600, acceleration: '3.9 sec', accelerationNumber: 3.9, topSpeed: '250 km/h', topSpeedNumber: 250, weight: '1,785 kg', weightNumber: 1785, engine: '2.9L twin-turbo V6', fuel: 'Petrol', drivetrain: 'AWD' },
  { id: 'c63', name: 'Mercedes-AMG C 63 S E Performance', price: '~€123,000', priceNumber: 123, power: '680 hp', powerNumber: 680, torque: '1,020 Nm', torqueNumber: 1020, acceleration: '3.4 sec', accelerationNumber: 3.4, topSpeed: '280 km/h', topSpeedNumber: 280, weight: '2,180 kg', weightNumber: 2180, engine: '2.0L turbo-4 + electric motor', fuel: 'Plug-in hybrid', drivetrain: 'AWD' },
  { id: 'model-3', name: 'Tesla Model 3 Performance', price: '~€60,000', priceNumber: 60, power: '510 hp*', powerNumber: 510, torque: '741 Nm*', torqueNumber: 741, acceleration: '3.1 sec', accelerationNumber: 3.1, topSpeed: '262 km/h', topSpeedNumber: 262, weight: '1,851 kg', weightNumber: 1851, engine: 'Dual electric motors', fuel: 'Electric', drivetrain: 'AWD' },
]

// Suggestions d'amorçage — reprises de la production.
export const QUICK_PROMPTS = [
  { label: 'Comparer deux voitures', prompt: 'Aide-moi à comparer deux voitures que j’hésite à acheter. Quels critères dois-je regarder en priorité ?' },
  { label: 'Trouver ma prochaine voiture', prompt: 'Aide-moi à trouver ma prochaine voiture. Pose-moi les bonnes questions sur mon budget et mon usage.' },
  { label: 'Comprendre une technologie', prompt: 'Explique-moi une technologie automobile que je ne comprends pas bien, avec des mots simples.' },
  { label: 'Préparer un achat', prompt: 'Je prépare un achat automobile. Donne-moi une checklist complète avant de signer.' },
]

export const HOME_ACTIONS = [
  { number: '01', icon: 'quote', title: 'Analyser mon devis', description: 'Vérifie mon devis de garage', prompt: null },
  { number: '02', icon: 'alert', title: 'Scanner un voyant ou un bruit', description: "Analyse une photo d'un voyant ou un court audio", prompt: 'Aide-moi à comprendre un voyant ou un bruit sur ma voiture. Je vais te décrire ce que je vois ou entends.' },
  { number: '03', icon: 'car', title: "Analyser une voiture d'occasion", description: 'Vérifie une voiture avant achat', prompt: 'Aide-moi à analyser une voiture d’occasion avant achat. Quels points dois-je vérifier en priorité ?' },
]
