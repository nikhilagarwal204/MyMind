/* eslint-disable no-console */
import { PassThrough } from 'node:stream'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as fs from 'node:fs'
import Koa from 'koa'
import { koaBody } from 'koa-body'
import Router from 'koa-router'
import { HumanChatMessage, HumanMessage } from 'langchain/schema'
import type formidable from 'formidable'
import Server from 'koa-static'
import { chatStream } from './chatStream.ts'
import { chatMindMap } from './chatMindMap.ts'
import { configureProxyEnvironment, isEmptyKey } from './utils/useOpenAIProxy.ts'
import { initialDocument, queryDocument, queryDocumentStream } from './document.ts'
import { Language, validateWord } from './utils/useValidateLanguage.ts'
import { compressContent } from './compressContent.ts'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
enum MessageStatus {
  PENDING = 'pending',
  DONE = 'done',
  FAILED = 'failed',
}
const app = new Koa()
const router = new Router()
const PORT = 3000

app.use(koaBody({
  encoding: 'utf-8',
  multipart: true,
  formidable: {
    uploadDir: path.join(__dirname, '/uploads/'),
    keepExtensions: true,
  },
}))
app.use(Server(path.join(__dirname, '/uploads/')))

app.use(router.routes())
app.use(router.allowedMethods())

app.listen(PORT, () => {
  console.log(`open server http://localhost:${PORT}`)
})

router.get('/', (ctx) => {
  ctx.body = 'hello server'
})

function useChatSteam(ctx: Koa.ParameterizedContext<any, Router.IRouterParamContext<any, object>, any>) {
  const headers = {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  }
  ctx.set(headers)
  const sseStream = new PassThrough()
  ctx.body = sseStream
  const sendData = (data: string) => {
    sseStream.write(`id: ${Date.now()}\n`)
    sseStream.write('type: message\n')
    sseStream.write(`data: ${data}\n\n`)
  }
  function messageSend(token: string) {
    const message = {
      status: MessageStatus.PENDING,
      data: token,
    }
    sendData(JSON.stringify(message))
  }
  function messageDone() {
    const message = {
      status: MessageStatus.DONE,
    }
    sendData(JSON.stringify(message))
    sseStream.end()
  }
  function messageError(e: any) {
    ctx.status = 400
    if (typeof e === 'object' && e.error && e.error.code)
      sseStream.write(e.error.code)
    else
      sseStream.write(e)

    sseStream.end()
  }

  return {
    messageSend,
    messageDone,
    messageError,
  }
}

router.post('/chat', async (ctx) => {
  let { messages } = ctx.request.body
  if (!messages)
    ctx.throw(400, 'No message')

  if (!Array.isArray(messages) && typeof messages === 'string')
    messages = [messages]

  const { messageSend, messageDone } = useChatSteam(ctx)
  chatStream(messages, messageSend, messageDone)
})

router.post('/chatMindMap', async (ctx) => {
  const { topic } = ctx.request.body
  const headers = {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  }
  ctx.set(headers)
  const sseStream = new PassThrough()
  ctx.body = sseStream
  if (!topic) {
    sseStream.write('Please set topic')
    sseStream.end()
  }
  if (isEmptyKey(ctx)) {
    sseStream.write('Please set openai key')
    sseStream.end()
  }
  function generatePrompt(topic: string) {
    let prompt: HumanMessage
    const pattern = /[\u4E00-\u9FA5]+/
    if (pattern.test(topic)) {
      prompt = new HumanMessage(
        `为主题${topic}创建一个思维导图/指南
        要求：
        1.使用markdown
        2.语言简洁
        3.通常有3个级别
      `)
    }
    else {
      prompt = new HumanMessage(
        `create a road map / guide line for the topic ${topic}
        requirement:
        1.use markdown
        2.short language is preferred
        3.usually, there are 3 levels
      `)
    }
    return prompt
  }

  const prompt = generatePrompt(topic)
  const chatStream = useChatSteam(ctx)
  const proxyEnvironment = configureProxyEnvironment(ctx)

  chatMindMap(prompt, chatStream, proxyEnvironment)
})

// omi apps webhook api memory trigger integration
router.post('/myMind', async (ctx) => {
  const { uid } = ctx.query
  const memoryPayload = ctx.request.body

  // Set up SSE (Server-Sent Events) headers
  const headers = {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  }
  ctx.set(headers)

  const sseStream = new PassThrough()
  ctx.body = sseStream

  // Validate input
  if (!uid) {
    sseStream.write('event: error\ndata: Missing user ID\n\n')
    sseStream.end()
    return
  }

  if (!memoryPayload) {
    sseStream.write('event: error\ndata: No memory payload received\n\n')
    sseStream.end()
    return
  }

  // Extract key information from the memory
  const {
    transcript,
    structured = {},
    transcript_segments = [],
  } = memoryPayload

  // Determine the topic for mind map generation
  const topic = structured.title
    || structured.overview
    || (transcript_segments.length > 0 ? transcript_segments[0].text : 'Untitled Memory')

  // Generate prompt based on the topic
  function generatePrompt(topic: string) {
    return new HumanMessage(
      `Create a roadmap/guideline for the topic: ${topic}
        Context:
        - From user memory: ${transcript?.slice(0, 200) || 'No additional context'}
        - Related action items: ${structured.action_items?.map((item: { description: string }) => item.description).join(', ') || 'None'}

        Requirements:
        1. Use markdown
        2. Use concise language
        3. Usually 3 levels deep
        4. Incorporate background and action items from the memory
      `)
  }

  try {
    // Generate prompt based on the topic
    const prompt = generatePrompt(topic)

    // Configure chat streaming and proxy
    const chatStream = useChatSteam(ctx)
    const proxyEnvironment = configureProxyEnvironment(ctx)

    // Generate mind map
    await chatMindMap(prompt, chatStream, proxyEnvironment, {
      // Optional: Pass additional context from the memory
      metadata: {
        memoryId: memoryPayload.id,
        userId: uid,
        category: structured.category,
        actionItems: structured.action_items,
      },
    })

    // Send success event
    sseStream.write('event: success\ndata: Mind map generated successfully\n\n')
  }
  catch (error: unknown) {
    // Handle and report any errors
    const errorMessage = error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : 'An unknown error occurred'

    console.error('Mind map generation error:', errorMessage)
    sseStream.write(`event: error\ndata: ${errorMessage}\n\n`)
  }
  finally {
    sseStream.end()
  }
})

// write a setup-success api route, return {"is_setup_completed": true}
router.get('/setup-success', async (ctx) => {
  ctx.body = {
    is_setup_completed: true,
  }
})

router.post('/uploadFile', async (ctx) => {
  const file = ctx.request.files
  if (!file || Object.keys(file).length === 0) {
    ctx.status = 400
    ctx.body = {
      success: false,
      message: 'No file',
    }
  }
  const fileName = ((ctx.request.files!).files as formidable.File).newFilename

  ctx.body = {
    success: true,
    fileName,
  }
})

router.get('/document/fileList', async (ctx) => {
  const directoryPath = path.join(__dirname, 'uploads')
  try {
    const files = await fs.promises.readdir(directoryPath)
    ctx.body = {
      success: true,
      data: { files },
    }
  }
  catch (err: any) {
    console.log(`Unable to scan directory: ${err}`)
    ctx.body = {
      success: false,
      error: err.message,
    }
  }
})

router.post('/document/init', async (ctx) => {
  const { fileName } = ctx.request.body
  const vectorStore = await initialDocument(fileName)
  ctx.body = {
    success: !!vectorStore,
  }
})

router.post('/document/query', async (ctx) => {
  const { query, fileName, isStream } = ctx.request.body
  if (!fileName) {
    ctx.status = 400
    ctx.body = {
      success: false,
      message: 'Please create index first',
    }
    return
  }
  if (isStream) {
    queryDocumentStream(query[0], fileName, useChatSteam(ctx), configureProxyEnvironment(ctx))
  }
  else {
    const result = await queryDocument(query[0], fileName)
    ctx.body = {
      success: true,
      data: { result },
    }
  }
})

router.post('/compressContent', async (ctx) => {
  const { content } = ctx.request.body
  if (!content)
    ctx.throw(400, 'No content')
  const result = await compressContent(content)
  ctx.body = {
    success: true,
    result,
  }
})
