import knex from 'knex'
const db = knex({ client: 'pg', connection: process.env.WB_URL, pool: { min: 1, max: 2 } })
const one = async (sql) => (await db.raw(sql)).rows[0]
const v = await one(`select count(*) n from whitebox_awareness_exposures
  where source='video' and (content_url ilike '%gpointpremium%' or content_url ilike '%istoriyata%' or meta->>'page_url' ilike '%gpointpremium%')`)
const c = await one(`select count(*) n from whitebox_engagement_content
  where url ilike '%gpointpremium%' or url ilike '%istoriyata%'`)
console.log(`video_exposures=${v.n} content_rows=${c.n}`)
await db.destroy()
