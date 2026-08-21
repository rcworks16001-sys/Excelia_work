require('dotenv').config();
const pool = require('./index');

// EXCELIA demo data — the 13 property listings pre-loaded for the demo.
// Never hardcode listing data anywhere else (bot prompts, frontend) — this is
// the only place listing data is authored; everything else reads from the DB.
//
// NOTE — placeholders still pending:
//   - photos: real Cloudinary URLs get added per-listing via the dashboard
//     or backend/scripts/bulk-upload-photos.js, not authored here.
//   - latitude/longitude: approximate neighbourhood-level demo coordinates,
//     not exact property addresses. Location/map sending not built yet.
//
// agency_contact is intentionally the SAME static value on every listing —
// client decision: no per-agency numbers, always show the EXCELIA office.

const EXCELIA_OFFICE_CONTACT = '+228 91062626 — EXCELIA office';

const listings = [
    {
        city: 'Lomé', neighbourhood: 'Adidogomé', type: 'chambre_salon',
        price: 35000, bedrooms: 1,
        description: "Chambre salon calme, proche axe principal, eau et électricité inclus.",
        latitude: 6.1725, longitude: 1.1660,
    },
    {
        city: 'Lomé', neighbourhood: 'Avédji', type: 'appartement',
        price: 90000, bedrooms: 2,
        description: "Appartement 2 chambres dans cour commune sécurisée, quartier résidentiel calme.",
        latitude: 6.1750, longitude: 1.1900,
    },
    {
        city: 'Lomé', neighbourhood: 'Bè', type: 'villa',
        price: 350000, bedrooms: 4,
        description: "Villa 4 chambres avec cour clôturée, proche de la mer, quartier animé.",
        latitude: 6.1200, longitude: 1.2500,
    },
    {
        city: 'Noèpé', neighbourhood: 'Centre', type: 'terrain',
        price: 6000000, bedrooms: null,
        description: "Terrain de 600 m², titre foncier disponible, idéal pour construction.",
        latitude: 6.6200, longitude: 1.3300,
    },
    {
        city: 'Lomé', neighbourhood: 'Agoè-Nyivé', type: 'mini_villa',
        price: 180000, bedrooms: 3,
        description: "Mini-villa 3 chambres, cour privée, quartier calme en pleine expansion.",
        latitude: 6.1900, longitude: 1.1800,
    },
    {
        city: 'Lomé', neighbourhood: 'Tokoin', type: 'appartement_meuble',
        price: 150000, bedrooms: 2,
        description: "Appartement meublé 2 chambres, climatisé, idéal pour expatriés.",
        latitude: 6.1450, longitude: 1.2150,
    },
    {
        city: 'Lomé', neighbourhood: 'Kodjoviakopé', type: 'chambre_salon',
        price: 45000, bedrooms: 1,
        description: "Chambre salon proche du centre-ville, accès facile aux commerces.",
        latitude: 6.1280, longitude: 1.2100,
    },
    {
        city: 'Lomé', neighbourhood: 'Djidjolé', type: 'appartement',
        price: 110000, bedrooms: 3,
        description: "Appartement 3 chambres, immeuble sécurisé avec parking.",
        latitude: 6.1600, longitude: 1.2300,
    },
    {
        city: 'Lomé', neighbourhood: 'Hédzranawoé', type: 'villa',
        price: 450000, bedrooms: 5,
        description: "Grande villa 5 chambres proche de l'aéroport, piscine et jardin.",
        latitude: 6.1550, longitude: 1.2500,
    },
    {
        city: 'Noèpé', neighbourhood: 'Route Nationale', type: 'terrain',
        price: 4500000, bedrooms: null,
        description: "Terrain de 450 m² en bordure de route nationale, bien exposé.",
        latitude: 6.6150, longitude: 1.3250,
    },
    {
        city: 'Lomé', neighbourhood: 'Adakpamé', type: 'mini_villa',
        price: 220000, bedrooms: 3,
        description: "Mini-villa moderne 3 chambres, quartier résidentiel calme.",
        latitude: 6.1650, longitude: 1.2600,
    },
    {
        city: 'Lomé', neighbourhood: 'Attiegou', type: 'appartement_meuble',
        price: 130000, bedrooms: 2,
        description: "Appartement meublé 2 chambres, proche des grandes artères.",
        latitude: 6.1500, longitude: 1.2450,
    },
    {
        city: 'Lomé', neighbourhood: 'Baguida', type: 'villa',
        price: 500000, bedrooms: 4,
        description: "Villa 4 chambres en bord de mer, quartier calme et prisé.",
        latitude: 6.1450, longitude: 1.3550,
    },
];

const seed = async () => {
    try {
        const existing = await pool.query('SELECT COUNT(*) FROM properties');
        if (parseInt(existing.rows[0].count, 10) > 0) {
            console.log('Properties table already has data — skipping seed. Truncate the table first if you want to reseed.');
            process.exit(0);
        }

        for (const listing of listings) {
            await pool.query(
                `INSERT INTO properties
                    (city, neighbourhood, type, price, bedrooms, description, photos, latitude, longitude, agency_contact)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
                [
                    listing.city,
                    listing.neighbourhood,
                    listing.type,
                    listing.price,
                    listing.bedrooms,
                    listing.description,
                    [],
                    listing.latitude,
                    listing.longitude,
                    EXCELIA_OFFICE_CONTACT,
                ]
            );
        }

        console.log(`Seeded ${listings.length} properties.`);
        process.exit(0);
    } catch (error) {
        console.error('Seeding failed:', error);
        process.exit(1);
    }
};

seed();
