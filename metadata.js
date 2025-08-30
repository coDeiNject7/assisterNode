const fs = require('fs');
const path = require('path');
const pool = require('./db'); // Your existing MySQL connection module

const metadataPath = path.join(__dirname, 'metadata.json');

async function insertMetadata() {
  try {
    const rawData = fs.readFileSync(metadataPath, 'utf8');
    const songs = JSON.parse(rawData);

    for (const song of songs) {
      const { title, artist, file, album_art, audio_lang, lyrics } = song;

      // Insert each song into the 'songs' table
      await pool.query(
        `INSERT INTO songs (title, artist, file_url, album_art_url, audio_lang, lyrics)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [title, artist, file, album_art, audio_lang, JSON.stringify(lyrics)]
      );
    }
    console.log('Metadata inserted successfully!');
  } catch (error) {
    console.error('Error inserting metadata:', error);
  } finally {
    pool.end(); // Close the DB connection after insertion is done
  }
}

// Run the insertion script
insertMetadata();
