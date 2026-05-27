const express = require('express');
const livereload = require('livereload');
const connectLiveReload = require('connect-livereload');
const cors = require('cors');
const db = require('./database');

const app = express();
const port = 3000;

app.use(cors({
    origin(origin, callback) {
        if(!origin || origin === 'http://localhost:3000') {
            return callback(null, true);
        }
        return callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
}));

const liveReloadServer = livereload.createServer();
liveReloadServer.watch(__dirname, "public");

app.use(express.json());
app.use(connectLiveReload());
app.use(express.static('public'));

app.get('/', (req, res) => {
  res.send('Hello, World!');
});

app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});