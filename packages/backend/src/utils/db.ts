import postgres from "postgres";
import url from "url";

const isProduction = process.env.NODE_ENV === "production";

// Validate DATABASE_URL
if (!process.env.DATABASE_URL) {
  console.error('❌ DATABASE_URL is not set in the environment variables');
  process.exit(1);
}

// Parse the DATABASE_URL
let parsedUrl: url.URL;
try {
  parsedUrl = new url.URL(process.env.DATABASE_URL);
} catch (error) {
  console.error('❌ Invalid DATABASE_URL:', error);
  process.exit(1);
}

const sql = postgres(process.env.DATABASE_URL, {
  ssl: {
    rejectUnauthorized: false
  },
  idle_timeout: 20,
  max_lifetime: 60 * 5,
  transform: {
    ...postgres.camel,
    undefined: null,
  },
  types: {
    bigint: {
      ...postgres.BigInt,
      parse: (x: string) => {
        const number = Number(x);
        if (!Number.isSafeInteger(number)) {
          return Infinity;
        }
        return number;
      },
    },
  },
  max: isProduction ? 50 : 5,
  connection: {
    application_name: parsedUrl.searchParams.get('application_name') || `lunary-backend-${isProduction ? "production" : "development"}`
  },
  debug: (connection, query, parameters) => {
    console.log('Database Connection Debug:');
    console.log('Connection:', connection);
    console.log('Query:', query);
    console.log('Parameters:', parameters);
    console.log('Connection URL:', process.env.DATABASE_URL?.replace(/:[^:]*@/, ':****@'));
  },
  onnotice: process.env.LUNARY_DEBUG ? console.warn : () => {},
});

// Add a connection test function
export async function testDatabaseConnection() {
  try {
    console.log('🔍 Testing database connection...');
    const result = await sql`SELECT NOW()`;
    console.log('✅ Database connection successful');
    return true;
  } catch (error) {
    console.error('❌ Database connection failed:', error);
    
    // More detailed error logging
    if (error instanceof Error) {
      console.error('Error Name:', error.name);
      console.error('Error Message:', error.message);
      
      // Check for common connection issues
      if (error.message.includes('authentication')) {
        console.error('🚨 Authentication failed. Check your credentials.');
      }
      if (error.message.includes('connection refused')) {
        console.error('🚨 Connection refused. Check host, port, and firewall settings.');
      }
      if (error.message.includes('database does not exist')) {
        console.error('🚨 Database does not exist. Verify database name.');
      }
    }
    
    return false;
  }
}

export async function checkDbConnection() {
  try {
    await sql`select 1`;
    console.info("✅ Connected to database");
  } catch (error) {
    console.error("❌ Could not connect to database");
    process.exit(1);
  }
}

export default sql;
