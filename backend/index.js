const express = require('express');
const cors = require('cors');
require('dotenv').config();

const db = require('./src/db/index');
const webhookRoutes = require('./src/routes/webhook');
const propertiesRoutes = require('./src/routes/properties');
const leadsRoutes = require('./src/routes/leads');
const appointmentsRoutes = require('./src/routes/appointments');
const authRoutes = require('./src/routes/auth');

const app = express();

app.use(cors());
app.use(express.json());

// Routes
app.use('/webhook', webhookRoutes);
app.use('/api/properties', propertiesRoutes);
app.use('/api/leads', leadsRoutes);
app.use('/api/appointments', appointmentsRoutes);
app.use('/api/auth', authRoutes);

// Test route
app.get('/', (req, res) => {
    res.json({ message: 'EXCELIA backend is running' });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
