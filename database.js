const { Pool } = require("pg");
require('dotenv').config();

const db = new Pool({
    connectionString: process.env.DATABASE_URL
});

db.query("SELECT NOW()", (err, res) => {
    if (err)
        console.error("Error connecting to the database:", err);
    else
        console.log(res.rows[0].now);
});

const dbMake = async() => {
    await db.query(`
        CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            name VARCHAR(255) NOT NULL,
            email VARCHAR(255) UNIQUE NOT NULL,
            password VARCHAR(255) NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );    
    `)
};

dbMake();

module.exports = db;