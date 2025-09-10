const fs = require('fs');
const path = require('path');
const pool = require('./db'); // Your existing MySQL connection module

const metadataPath = path.join(__dirname, 'metadata.json');

async function insertMetadata() {
  try {
    const rawData = fs.readFileSync(metadataPath, 'utf8');
    const metadata = JSON.parse(rawData);

    // If your metadata.json wraps songs in { songs: [...] }
    const songs = metadata.songs || metadata;

    for (const song of songs) {
      const title = song.song || null;
      const artist = song.artists || null;
      const movie = song.movie || null;
      const year = song.year || null;
      const genre = song.genre || null;
      const composers = song.composers || null;
      const audio_lang = song.language || null;
      const label = song.label || null;
      const file_url = song.file || null;
      const album_art_url = song.album_art || null;
      const local_mp3 = song.local_mp3 || null;   // ensure null if missing
      const local_jpg = song.local_jpg || null;   // ensure null if missing
      const youtube_url = song.youtube || null;
      const lyrics = null; // Not present in JSON

      await pool.query(
        `INSERT INTO songs 
         (title, artist, movie, year, genre, composers, audio_lang, label, 
          file_url, album_art_url, local_mp3, local_jpg, youtube_url, lyrics)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          title, artist, movie, year, genre, composers, audio_lang, label,
          file_url, album_art_url, local_mp3, local_jpg, youtube_url, lyrics
        ]
      );
    }
    console.log('Metadata inserted successfully!');
  } catch (error) {
    console.error('Error inserting metadata:', error);
  } finally {
    pool.end(); // Close DB connection
  }
}

// Run the insertion script
insertMetadata();
