require('dotenv').config();
const { Client } = require('pg');
const { Upload } = require('@aws-sdk/lib-storage');
const { S3Client } = require('@aws-sdk/client-s3');
const { PassThrough } = require('stream');

async function backupDatabase() {
  // Connection configuration from environment variables
  const client = new Client({
    user: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD,
    host: process.env.POSTGRES_HOST,
    port: process.env.POSTGRES_PORT || '5432',
    database: process.env.POSTGRES_DB,
  });

  // Initialize S3 client for MinIO
  const s3Client = new S3Client({
    endpoint: process.env.MINIO_ENDPOINT || 'http://localhost:9000',
    region: 'ca-west-1', // MinIO requires a region but it can be any value
    credentials: {
      accessKeyId: process.env.MINIO_ACCESS_KEY,
      secretAccessKey: process.env.MINIO_SECRET_KEY
    },
    forcePathStyle: true // Required for MinIO
  });
  
  const passThrough = new PassThrough();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `backup-${timestamp}.sql`;

  // Start the MinIO upload
  const upload = new Upload({
    client: s3Client,
    params: {
      Bucket: process.env.MINIO_BUCKET,
      Key: filename,
      Body: passThrough
    }
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
    
    // For each table, stream schema and data
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
      passThrough.write(schema[Object.keys(schema)[0]] + '\n\n');
      
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
          passThrough.write(
            `INSERT INTO "${table_name}" (${Object.keys(row).map(k => `"${k}"`).join(', ')}) ` +
            `VALUES (${values.join(', ')});\n`
          );
        }
        passThrough.write('\n');
      }
    }
    
    // End the stream and wait for upload to complete
    passThrough.end();
    await upload.done();
    
    console.log(`Backup completed successfully and uploaded to MinIO: ${filename}`);
    
  } catch (error) {
    console.error('Backup failed:', error);
    process.exit(1);
  } finally {
    await client.end();
  }
}

backupDatabase();
