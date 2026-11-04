import { Hono } from 'hono'

const app = new Hono<{ Bindings: Env }>()

app.onError((err, c) => {
  return c.json({ error: err.message || 'Internal server error' }, 500)
})

// Health check
app.get('/api/health', (c) => c.json({ status: 'ok' }))

// Homes: Create home
app.post('/api/homes', async (c) => {
  const body = await c.req.json().catch(() => null)
  if (!body || typeof body.name !== 'string' || !body.name.trim()) {
    return c.json({ error: 'Name is required' }, 400)
  }

  const id = crypto.randomUUID()
  const name = body.name.trim()
  await c.env.DB.prepare('INSERT INTO homes (id, name) VALUES (?1, ?2)').bind(id, name).run()

  return c.json({ id, name }, 201)
})

// Homes: List homes (for web UI)
app.get('/api/homes', async (c) => {
  const { results: homes } = await c.env.DB.prepare(
    'SELECT id, name FROM homes ORDER BY rowid DESC',
  ).all<{ id: string; name: string }>()

  return c.json({ homes }, 200)
})

// Members: Add member to home
app.post('/api/homes/:homeId/members', async (c) => {
  const homeId = c.req.param('homeId')
  const home = await c.env.DB.prepare('SELECT id FROM homes WHERE id = ?1').bind(homeId).first()
  if (!home) {
    return c.json({ error: 'Home not found' }, 404)
  }

  const body = await c.req.json().catch(() => null)
  if (!body || typeof body.name !== 'string' || !body.name.trim()) {
    return c.json({ error: 'Name is required' }, 400)
  }

  const id = crypto.randomUUID()
  const name = body.name.trim()
  await c.env.DB.prepare('INSERT INTO members (id, home_id, name) VALUES (?1, ?2, ?3)')
    .bind(id, homeId, name)
    .run()

  return c.json({ id, homeId, name }, 201)
})

// Members: List members of a home (for web UI)
app.get('/api/homes/:homeId/members', async (c) => {
  const homeId = c.req.param('homeId')
  const home = await c.env.DB.prepare('SELECT id FROM homes WHERE id = ?1').bind(homeId).first()
  if (!home) {
    return c.json({ error: 'Home not found' }, 404)
  }

  const { results: members } = await c.env.DB.prepare(
    'SELECT id, home_id as homeId, name FROM members WHERE home_id = ?1 ORDER BY rowid ASC',
  )
    .bind(homeId)
    .all<{ id: string; homeId: string; name: string }>()

  return c.json({ members }, 200)
})

// Bills: Create and split a bill
app.post('/api/homes/:homeId/bills', async (c) => {
  const homeId = c.req.param('homeId')
  const home = await c.env.DB.prepare('SELECT id FROM homes WHERE id = ?1').bind(homeId).first()
  if (!home) {
    return c.json({ error: 'Home not found' }, 404)
  }

  const body = await c.req.json().catch(() => null)
  const totalCents = body?.totalCents
  if (typeof totalCents !== 'number' || !Number.isInteger(totalCents) || totalCents <= 0) {
    return c.json({ error: 'totalCents must be a positive integer' }, 422)
  }

  if (typeof body?.title !== 'string' || !body.title.trim()) {
    return c.json({ error: 'Title is required' }, 422)
  }

  const { results: members } = await c.env.DB.prepare(
    'SELECT id, name FROM members WHERE home_id = ?1 ORDER BY rowid ASC',
  )
    .bind(homeId)
    .all<{ id: string; name: string }>()

  if (members.length === 0) {
    return c.json({ error: 'Home has no members' }, 422)
  }

  const n = members.length
  const baseAmount = Math.floor(totalCents / n)
  const remainder = totalCents % n
  const billId = crypto.randomUUID()
  const title = body.title.trim()

  const shares = members.map((member, index) => ({
    id: crypto.randomUUID(),
    memberId: member.id,
    amountCents: baseAmount + (index < remainder ? 1 : 0),
    paidAt: null as string | null,
  }))

  const statements = [
    c.env.DB.prepare(
      'INSERT INTO bills (id, home_id, title, total_cents) VALUES (?1, ?2, ?3, ?4)',
    ).bind(billId, homeId, title, totalCents),
    ...shares.map((s) =>
      c.env.DB.prepare(
        'INSERT INTO shares (id, bill_id, member_id, amount_cents) VALUES (?1, ?2, ?3, ?4)',
      ).bind(s.id, billId, s.memberId, s.amountCents),
    ),
  ]
  await c.env.DB.batch(statements)

  return c.json({ id: billId, homeId, title, totalCents, shares }, 201)
})

// Bills: List bills of a home with shares (for web UI)
app.get('/api/homes/:homeId/bills', async (c) => {
  const homeId = c.req.param('homeId')
  const home = await c.env.DB.prepare('SELECT id FROM homes WHERE id = ?1').bind(homeId).first()
  if (!home) {
    return c.json({ error: 'Home not found' }, 404)
  }

  type BillRow = {
    billId: string
    title: string
    totalCents: number
    shareId: string | null
    memberId: string | null
    memberName: string | null
    amountCents: number | null
    paidAt: string | null
  }

  const { results } = await c.env.DB.prepare(`
    SELECT
      b.id AS billId,
      b.title,
      b.total_cents AS totalCents,
      s.id AS shareId,
      s.member_id AS memberId,
      m.name AS memberName,
      s.amount_cents AS amountCents,
      s.paid_at AS paidAt
    FROM bills b
    LEFT JOIN shares s ON s.bill_id = b.id
    LEFT JOIN members m ON m.id = s.member_id
    WHERE b.home_id = ?1
    ORDER BY b.rowid DESC, s.rowid ASC
  `)
    .bind(homeId)
    .all<BillRow>()

  type ShareItem = {
    id: string
    memberId: string
    memberName: string
    amountCents: number
    paidAt: string | null
  }

  type BillItem = {
    id: string
    homeId: string
    title: string
    totalCents: number
    shares: ShareItem[]
  }

  const billsMap = new Map<string, BillItem>()

  for (const row of results) {
    let bill = billsMap.get(row.billId)
    if (!bill) {
      bill = {
        id: row.billId,
        homeId,
        title: row.title,
        totalCents: row.totalCents,
        shares: [],
      }
      billsMap.set(row.billId, bill)
    }
    if (row.shareId && row.memberId && row.amountCents !== null) {
      bill.shares.push({
        id: row.shareId,
        memberId: row.memberId,
        memberName: row.memberName ?? 'Unknown',
        amountCents: row.amountCents,
        paidAt: row.paidAt,
      })
    }
  }

  return c.json({ bills: Array.from(billsMap.values()) }, 200)
})

// Shares: Pay a share
app.post('/api/bills/:billId/shares/:shareId/pay', async (c) => {
  const billId = c.req.param('billId')
  const shareId = c.req.param('shareId')
  const idempotencyKey = c.req.header('Idempotency-Key')?.trim()

  if (!idempotencyKey) {
    return c.json({ error: 'Idempotency-Key header is required' }, 400)
  }

  const bill = await c.env.DB.prepare('SELECT id FROM bills WHERE id = ?1').bind(billId).first()
  if (!bill) {
    return c.json({ error: 'Bill not found' }, 404)
  }

  type ShareRecord = {
    id: string
    member_id: string
    amount_cents: number
    paid_at: string | null
    idempotency_key: string | null
  }

  const share = await c.env.DB.prepare(
    'SELECT id, member_id, amount_cents, paid_at, idempotency_key FROM shares WHERE id = ?1 AND bill_id = ?2',
  )
    .bind(shareId, billId)
    .first<ShareRecord>()

  if (!share) {
    return c.json({ error: 'Share not found' }, 404)
  }

  if (share.paid_at !== null) {
    if (share.idempotency_key === idempotencyKey) {
      return c.json(
        {
          id: share.id,
          memberId: share.member_id,
          amountCents: share.amount_cents,
          paidAt: share.paid_at,
        },
        200,
      )
    }
    return c.json({ error: 'Share already paid with a different key' }, 409)
  }

  const now = new Date().toISOString()
  const updated = await c.env.DB.prepare(`
    UPDATE shares
    SET paid_at = ?1, idempotency_key = ?2
    WHERE id = ?3 AND bill_id = ?4 AND paid_at IS NULL
    RETURNING id, member_id, amount_cents, paid_at, idempotency_key
  `)
    .bind(now, idempotencyKey, shareId, billId)
    .first<ShareRecord>()

  if (updated) {
    return c.json(
      {
        id: updated.id,
        memberId: updated.member_id,
        amountCents: updated.amount_cents,
        paidAt: updated.paid_at,
      },
      200,
    )
  }

  // If another concurrent request just completed the payment, check the current state
  const current = await c.env.DB.prepare(
    'SELECT id, member_id, amount_cents, paid_at, idempotency_key FROM shares WHERE id = ?1 AND bill_id = ?2',
  )
    .bind(shareId, billId)
    .first<ShareRecord>()

  if (current && current.idempotency_key === idempotencyKey) {
    return c.json(
      {
        id: current.id,
        memberId: current.member_id,
        amountCents: current.amount_cents,
        paidAt: current.paid_at,
      },
      200,
    )
  }

  return c.json({ error: 'Share already paid with a different key' }, 409)
})

// Balances: Get balances of all members in a home
app.get('/api/homes/:homeId/balances', async (c) => {
  const homeId = c.req.param('homeId')
  const home = await c.env.DB.prepare('SELECT id FROM homes WHERE id = ?1').bind(homeId).first()
  if (!home) {
    return c.json({ error: 'Home not found' }, 404)
  }

  const { results: balances } = await c.env.DB.prepare(`
    SELECT
      m.id AS memberId,
      m.name AS name,
      COALESCE(
        (
          SELECT SUM(s.amount_cents)
          FROM shares s
          JOIN bills b ON b.id = s.bill_id
          WHERE s.member_id = m.id
            AND b.home_id = m.home_id
            AND s.paid_at IS NULL
        ),
        0
      ) AS outstandingCents
    FROM members m
    WHERE m.home_id = ?1
    ORDER BY m.rowid ASC
  `)
    .bind(homeId)
    .all<{ memberId: string; name: string; outstandingCents: number }>()

  return c.json({ balances }, 200)
})

export default app
