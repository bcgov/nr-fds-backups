require('dotenv').config();
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

async function backupDatabase() {
  // Connection configuration for local Docker container
  const client = new Client({
    host: 'localhost',
    port: 5432,
    database: 'postgres',
    user: 'postgres',
    password: 'default'
  });
  
  try {
    console.log('Starting database backup...');
    await client.connect();
    
    // Get all tables
    const tableQuery = `
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_type = 'BASE TABLE'
    `;
    const { rows: tables } = await client.query(tableQuery);
    
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `backup-${timestamp}.sql`;
    const backupPath = path.join(__dirname, filename);
    const writeStream = fs.createWriteStream(backupPath);
    
    // For each table, dump schema and data
    for (const { table_name } of tables) {
      console.log(`Processing table: ${table_name}`);
      
      // Get table schema
      const schemaQuery = `
        SELECT 
          'CREATE TABLE IF NOT EXISTS "' || table_name || '" (' ||
          string_agg(
            '"' || column_name || '" ' || data_type ||
            CASE 
              WHEN character_maximum_length IS NOT NULL 
              THEN '(' || character_maximum_length || ')'
              ELSE ''
            END ||
            CASE WHEN is_nullable = 'NO' THEN ' NOT NULL' ELSE '' END,
            ', '
          ) || ');'
        FROM information_schema.columns
        WHERE table_name = $1
        AND table_schema = 'public'
        GROUP BY table_name;
      `;
      const { rows: [schema] } = await client.query(schemaQuery, [table_name]);
      writeStream.write(schema[Object.keys(schema)[0]] + '\n\n');
      
      // Get table data
      const dataQuery = `SELECT * FROM "${table_name}"`;
      const { rows: data } = await client.query(dataQuery);
      
      if (data.length > 0) {
        for (const row of data) {
          const values = Object.values(row).map(value => 
            value === null ? 'NULL' : 
            typeof value === 'string' ? `'${value.replace(/'/g, "''")}'` :
            value instanceof Date ? `'${value.toISOString()}'` :
            value
          );
          writeStream.write(
            `INSERT INTO "${table_name}" (${Object.keys(row).map(k => `"${k}"`).join(', ')}) ` +
            `VALUES (${values.join(', ')});\n`
          );
        }
        writeStream.write('\n');
      }
    }
    
    writeStream.end();
    console.log(`Backup completed successfully: ${filename}`);
    
  } catch (error) {
    console.error('Backup failed:', error);
    process.exit(1);
  } finally {
    await client.end();
  }
}

backupDatabase();
