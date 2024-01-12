import sql from "@/utils/db"
import Router from "koa-router"
import stripe from "@/utils/stripe"
import { OpenAIStream, StreamingTextResponse } from "ai"
import OpenAI from "openai"
import { completion } from "litellm"
import { z } from "zod"
import Context from "@/utils/koa"
import { clearUndefined } from "@/utils/ingest"
import project from "./projects"

const orgs = new Router({
  prefix: "/orgs/:orgId",
})

orgs.use("", project.routes())

orgs.get("/", async (ctx: Context) => {
  const orgId = ctx.params.orgId as string

  const [row] = await sql`
    select
      id,
      created_at,
      plan,
      billing,
      play_allowance,
      limited,
      verified,
      plan_period,
      canceled,
      stripe_customer,
      stripe_subscription,  
      name
    from
      org
    where
      id = ${orgId}
  `

  ctx.body = row
})

orgs.patch("/", async (ctx: Context) => {
  const orgId = ctx.params.orgId as string
  const bodySchema = z.object({
    name: z.string(),
  })

  const { name } = bodySchema.parse(ctx.request.body)

  await sql`
      update org
      set
        name = ${name}
      where
        id = ${orgId}
    `
  ctx.body = {}
})

orgs.get("/projects", async (ctx: Context) => {
  const orgId = ctx.params.orgId as string

  const rows = await sql`
    select
      id,
      created_at,
      name,
      org_id,
      exists(select * from run where app = app.id) as activated
    from
      app
    where
      org_id = ${orgId}
  `

  ctx.body = rows
})

orgs.post("/projects", async (ctx: Context) => {
  const orgId = ctx.state.orgId

  const bodySchema = z.object({
    name: z.string(),
  })
  const { name } = bodySchema.parse(ctx.request.body)

  const newProject = {
    name,
    orgId,
  }

  const [project] = await sql`insert into app ${sql(newProject)} returning *`

  ctx.body = project
})

orgs.delete("/projects/:projectId", async (ctx: Context) => {
  const projectId = ctx.params.projectId as string
  const orgId = ctx.state.orgId

  const [{ count }] =
    await sql`select count(*)::int from  app where org_id = ${orgId}`

  if (count > 1) {
    await sql`delete from app where id = ${projectId}`
    ctx.status = 200
    return
  } else {
    ctx.status = 422

    ctx.body = {
      error: "Deletion Failed",
      message: "An organization must have at least one project.",
    }
    return
  }
})

orgs.patch("/projects/:projectId", async (ctx: Context) => {
  const projectId = ctx.params.projectId as string
  const bodySchema = z.object({
    name: z.string(),
  })
  const { name } = bodySchema.parse(ctx.request.body)

  await sql`
      update app
      set
        name = ${name}
      where
        id = ${projectId}
    `
  ctx.status = 200
  ctx.body = {}
})

orgs.get("/usage", async (ctx: Context) => {
  const orgId = ctx.params.orgId as string
  const { projectId } = ctx.request.query

  const rows = await sql`
    select
      date_trunc('day', r.created_at) as date,
      count(*) as count
    from
      run r 
    ${!projectId ? sql`join app a on r.app = a.id` : sql``}
    where
      ${!projectId ? sql`a.org_id = ${orgId} and` : sql``}
      ${projectId ? sql`r.app = ${projectId} and` : sql``}
      r.created_at > now() - interval '30 days'
    group by
      date
    order by
    date desc;
  `

  ctx.body = rows
})

orgs.post("/upgrade", async (ctx: Context) => {
  const orgId = ctx.params.orgId as string

  const { plan, period, origin } = ctx.request.body as {
    plan: string
    period: string
    origin: string
  }

  const lookupKey = `${plan}_${period}`

  const prices = await stripe.prices.list({
    lookup_keys: [lookupKey],
  })

  if (prices.data.length === 0) {
    throw new Error("No price found for this plan and period")
  }

  const priceId = prices.data[0].id as string

  const [org] = await sql`
    select
      id,
      plan,
      stripe_customer,
      stripe_subscription
    from
      org
    where
      id = ${orgId}
  `

  if (!org) throw new Error("Org not found")

  if (!org.stripe_subscription) {
    const checkoutSession = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      client_reference_id: orgId,
      customer: org.stripeCustomer || undefined,
      metadata: {
        plan,
        period,
      },
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      success_url: `${origin}/billing/thank-you`,
      cancel_url: `${origin}/billing`,
    })

    return (ctx.body = { ok: true, url: checkoutSession.url })
  } else {
    const subscription = await stripe.subscriptions.retrieve(
      org.stripeSubscription,
    )

    const subItem = subscription.items.data[0].id

    // Update user subscription with new price
    await stripe.subscriptions.update(org.stripeSubscription, {
      cancel_at_period_end: false,
      metadata: {
        plan,
        period,
      },
      items: [
        {
          id: subItem,
          price: priceId,
        },
      ],
    })

    // Update org plan
    await sql`
      update org
      set
        plan = ${plan}
      where
        id = ${orgId}
    `
  }

  ctx.body = { ok: true }
})

const OPENROUTER_MODELS = [
  "mistralai/mistral-7b-instruct",
  "openai/gpt-4-32k",
  "openchat/openchat-7b",
  "teknium/openhermes-2.5-mistral-7b",
  "mistralai/mixtral-8x7b-instruct",
  "open-orca/mistral-7b-openorca",
  "perplexity/pplx-70b-chat",
  "perplexity/pplx-7b-chat",
  "google/gemini-pro",
  "google/palm-2-chat-bison",
  "meta-llama/llama-2-13b-chat",
  "meta-llama/llama-2-70b-chat",
]

const ANTHROPIC_MODELS = ["claude-2", "claude-2.0", "claude-instant-v1"]

const convertInputToOpenAIMessages = (input: any[]) => {
  return input.map(({ role, content, text, functionCall, toolCalls, name }) => {
    return clearUndefined({
      role: role.replace("ai", "assistant"),
      content: content || text,
      function_call: functionCall || undefined,
      tool_calls: toolCalls || undefined,
      name: name || undefined,
    })
  })
}

// Replace {{variable}} with the value of the variable using regex
const compileTemplate = (
  content: string,
  variables: Record<string, string>,
) => {
  const regex = /{{(.*?)}}/g
  return content.replace(regex, (_, g1) => variables[g1] || "")
}

type ChunkResult = {
  choices: { message: any }[]
  tokens: number
}

async function handleStream(
  stream: ReadableStream,
  onNewToken: (data: ChunkResult) => void,
  onComplete: () => void,
  onError: (e: Error) => void,
) {
  try {
    let tokens = 0
    let choices: any[] = []
    let res: ChunkResult
    for await (const part of stream) {
      // 1 chunk = 1 token
      tokens += 1

      const chunk = part.choices[0]

      const { index, delta } = chunk

      const { content, function_call, role, tool_calls } = delta

      if (!choices[index]) {
        choices.splice(index, 0, {
          message: { role, content, function_call, tool_calls: [] },
        })
      }

      if (content) choices[index].message.content += content || ""

      if (role) choices[index].message.role = role

      if (function_call?.name)
        choices[index].message.function_call.name = function_call.name

      if (function_call?.arguments)
        choices[index].message.function_call.arguments +=
          function_call.arguments

      if (tool_calls) {
        for (const tool_call of tool_calls) {
          const existingCallIndex = choices[index].message.tool_calls.findIndex(
            (tc) => tc.index === tool_call.index,
          )

          if (existingCallIndex === -1) {
            choices[index].message.tool_calls.push(tool_call)
          } else {
            const existingCall =
              choices[index].message.tool_calls[existingCallIndex]

            if (tool_call.function?.arguments) {
              existingCall.function.arguments += tool_call.function.arguments
            }
          }
        }
      }

      res = {
        choices,
        tokens,
      }

      onNewToken(res)
    }

    // remove the `index` property from the tool_calls if any
    // as it's only used to help us merge the tool_calls
    choices = choices.map((c) => {
      if (c.message.tool_calls) {
        c.message.tool_calls = c.message.tool_calls.map((tc) => {
          const { index, ...rest } = tc
          return rest
        })
      }
      return c
    })

    res = {
      choices,
      tokens,
    }

    onNewToken(res)

    onComplete()
  } catch (error) {
    console.error(error)
    onError(error)
  }
}

orgs.post("/playground", async (ctx: Context) => {
  const orgId = ctx.params.orgId as string
  const requestBodySchema = z.object({
    content: z.array(z.any()),
    extra: z.any(),
    testValues: z.record(z.string()),
  })
  const { content, extra, testValues } = requestBodySchema.parse(
    ctx.request.body,
  )

  ctx.request.socket.setTimeout(0)
  ctx.request.socket.setNoDelay(true)
  ctx.request.socket.setKeepAlive(true)

  ctx.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  })

  const [org] = await sql`
    select play_allowance
    from org
    where id = ${orgId}
  `

  if (org?.playAllowance <= 0) {
    throw new Error(
      "No allowance left today. Wait tomorrow or upgrade to continue using the playground.",
    )
  }

  // substract play allowance
  await sql`
    update org
    set play_allowance = play_allowance - 1
    where id = ${orgId}
  `

  let copy = [...content]

  // The template build happens here
  if (testValues) {
    for (const item of copy) {
      item.content = compileTemplate(item.content, testValues)
    }
  }

  const model = extra?.model || "gpt-3.5-turbo"

  const messages = convertInputToOpenAIMessages(copy)

  let method

  if (ANTHROPIC_MODELS.includes(model)) {
    method = completion
  } else {
    const openAIparams = OPENROUTER_MODELS.includes(model)
      ? {
          apiKey: process.env.OPENROUTER_API_KEY,
          baseURL: "https://openrouter.ai/api/v1",
          defaultHeaders: {
            "HTTP-Referer": "https://lunary.ai",
            "X-Title": `Lunary.ai`,
          },
        }
      : {
          apiKey: process.env.OPENAI_API_KEY,
        }

    const openai = new OpenAI(openAIparams)

    method = openai.chat.completions.create.bind(openai.chat.completions)
  }

  const res = await method({
    model,
    messages,
    temperature: extra?.temperature,
    max_tokens: extra?.max_tokens,
    top_p: extra?.top_p,
    top_k: extra?.top_k,
    presence_penalty: extra?.presence_penalty,
    frequency_penalty: extra?.frequency_penalty,
    stop: extra?.stop,
    functions: extra?.functions,
    tools: extra?.tools,
    seed: extra?.seed,
    stream: true,
  })

  const stream = new PassThrough()
  stream.pipe(ctx.res)
  ctx.status = 200
  ctx.body = stream

  handleStream(
    res,
    (data) => {
      stream.write(JSON.stringify(data) + "\n")
    },
    () => {
      stream.end()
    },
    () => {
      stream.end()
    },
  )
})

export default orgs
