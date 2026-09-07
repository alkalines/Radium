import { Hono } from 'hono'
const app = new Hono()

app.get('/health', (c) => {
  return c.json({
    health: 'ok'
  })
})

export default app