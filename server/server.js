// server.js - تحليل تفصيلي للفيديو/الصورة + معلومات صوت متقدمة
// =========================================

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import axios from 'axios';
import OpenAI from 'openai';
import dotenv from "dotenv";
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 🟢 إضافة دعم للملفات الثابتة من فولدر client
app.use(express.static(path.join(__dirname, "../client")));

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*', methods: ['GET', 'POST'], allowedHeaders: ['Content-Type'] }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// لو المستخدم دخل على الرابط الأساسي → نعرض صفحة الواجهة
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "../client/index.html"));
});

// فحص حالة السيرفر
app.get('/health', (_req, res) => {
  res.json({ ok: true, hasOpenAI: !!process.env.OPENAI_API_KEY, hasAssemblyAI: !!aaiKey });
});

// شغّل السيرفر على البورت الصحيح
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const FRAMES_DIR = path.join(__dirname, 'frames');
for (const d of [UPLOAD_DIR, FRAMES_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '');
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
  }
});
const upload = multer({ storage });

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const aaiKey = process.env.ASSEMBLYAI_API_KEY;

// مصفوفة لتخزين سياق المحادثة
let conversationHistory = [];
const trimHistory = () => {
  // حافظ على آخر ~24 رسالة فقط لتقليل الحجم
  if (conversationHistory.length > 24) {
    conversationHistory = conversationHistory.slice(-24);
  }
};

// أدوات مساعدة
async function cleanDir(dirPath) {
  try {
    const files = await fsp.readdir(dirPath);
    await Promise.all(files.map(f => fsp.unlink(path.join(dirPath, f)).catch(() => {})));
  } catch {}
}

// تحليل الصور/الفريمات (تفصيلي)
async function visionDescribeLocal(files = [], extraPrompt = '') {
  const baseInstruction = `
حلّل الصور التالية بدقة وقدّم تقريرًا **تفصيليًا** بالعربية يتضمن:
- العناصر/الكائنات الرئيسية مع تقدير أهميتها وسياقها.
- نصوص/أختام/أرقام/عناوين (OCR مبسّط) إن وُجدت، واذكر معناها.
- إشارات بصرية: شعارات، رموز، عملات، مستندات، جداول.
- تغيّرات المشهد/الإضاءة إن وُجدت، وما قد تعنيه.
- أي مخاطر/ملاحظات امتثال (عرض بيانات حساسة، أرقام هويات… إن ظهرت).
اكتب بعناوين فرعية واضحة ونقاط مرتبة. تجنّب الإطالة غير المفيدة.
${extraPrompt ? `\n\nتوجيه إضافي من المستخدم:\n${extraPrompt}\n` : ''}
  `.trim();

  const content = [
    { type: 'text', text: baseInstruction },
    ...files.map(filePath => ({
      type: 'image_url',
      image_url: {
        url: `data:image/jpeg;base64,${fs.readFileSync(filePath).toString('base64')}`
      }
    }))
  ];

  const resp = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [...conversationHistory, { role: 'user', content }],
    temperature: 0.2
  });

  const result = resp.choices?.[0]?.message?.content?.trim() || 'لم أتمكن من تحليل الصور.';
  conversationHistory.push({ role: 'assistant', content: result });
  trimHistory();
  return result;
}

// استخراج فريم واحد من الفيديو
async function extractFrame(videoPath, outPath, atSeconds) {
  return new Promise((resolve, reject) => {
    const args = ['-y', '-ss', String(atSeconds), '-i', videoPath, '-frames:v', '1', outPath];
    const p = spawn('ffmpeg', args, { stdio: 'ignore' });
    p.on('error', reject);
p.on('close', code => {
  if (code === 0 && fs.existsSync(outPath)) resolve(outPath);
  else resolve(null); // نرجع null بدل ما نعمل crash
});
  });
}

// حساب مدة الفيديو
async function getVideoDuration(videoPath) {
  return new Promise((resolve, reject) => {
    const args = ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', videoPath];
    const p = spawn('ffprobe', args);
    let out = '';
    p.stdout.on('data', d => out += d.toString());
    p.on('close', code => code === 0 ? resolve(parseFloat(out.trim()) || 0) : reject(new Error('ffprobe failed')));
  });
}

// استخراج فريمات ذكية + توقيت تقريبي لكل فريم
async function extractSmartFramesWithMeta(videoPath) {
  await cleanDir(FRAMES_DIR);
  const dur = await getVideoDuration(videoPath);


  let numFrames;
  if (dur <= 5) numFrames = 1; // فيديو أقل من 5 ثواني ناخد فريم واحد بس
  else if (dur <= 30) numFrames = 3;
  else if (dur <= 120) numFrames = 5;
  else if (dur <= 600) numFrames = 7;
  else numFrames = 10;

  const frames = [];
  const framesMeta = [];
  const step = dur > 0 ? dur / (numFrames + 1) : 1;
  for (let i = 1; i <= numFrames; i++) {
	const framePath = path.join(FRAMES_DIR, `frame${i}.jpg`);
	const t = Math.max(0.1, step * i);

	try {
	  await extractFrame(videoPath, framePath, t);
	  if (fs.existsSync(framePath)) {
	    frames.push(framePath);
	    framesMeta.push({ path: framePath, t }); // نضيفه بس لو فعلاً اتسحب
	  }
	} catch (err) {
	  console.warn(`⚠️ فشل استخراج الفريم عند الثانية ${t}:`, err.message);
	}

  }

  return { frames, framesMeta, duration: dur };
}

// استخراج الصوت من الفيديو كـ mp3 (يُحتمل عدم وجود صوت)
async function extractAudio(videoPath, outAudioPath) {
  return new Promise((resolve, reject) => {
    const args = ['-y', '-i', videoPath, '-vn', '-acodec', 'libmp3lame', outAudioPath];
    const p = spawn('ffmpeg', args, { stdio: 'ignore' });
    p.on('close', code => code === 0 ? resolve(outAudioPath) : reject(new Error('ffmpeg audio failed')));
  });
}

// تفريغ AssemblyAI (متقدّم)
async function transcribeWithAssemblyAI(filePath) {
  const stream = fs.createReadStream(filePath);
  const uploadRes = await axios({
    method: 'post',
    url: 'https://api.assemblyai.com/v2/upload',
    data: stream,
    headers: { authorization: aaiKey, 'transfer-encoding': 'chunked' },
    maxBodyLength: Infinity
  });
  const uploadUrl = uploadRes.data.upload_url;

  const createRes = await axios.post(
    'https://api.assemblyai.com/v2/transcript',
    {
      audio_url: uploadUrl,
      language_detection: true,
      speaker_labels: true,
      auto_chapters: true,
      auto_highlights: true,
      sentiment_analysis: true
    },
    { headers: { authorization: aaiKey, 'content-type': 'application/json' } }
  );

  const id = createRes.data.id;

  while (true) {
    await new Promise(r => setTimeout(r, 2000));
    const getRes = await axios.get(`https://api.assemblyai.com/v2/transcript/${id}`, {
      headers: { authorization: aaiKey }
    });

    const d = getRes.data;
    if (d.status === 'completed') {
      return {
        text: d.text || '',
        speakers: Array.isArray(d.utterances) ? d.utterances.map(u => ({
          speaker: u.speaker || null,
          text: u.text || '',
          start: u.start,
          end: u.end
        })) : [],
        chapters: Array.isArray(d.chapters) ? d.chapters.map(c => ({
          start: c.start,
          end: c.end,
          headline: c.headline || '',
          summary: c.summary || ''
        })) : [],
        highlights: Array.isArray(d.auto_highlights_result?.results) ? d.auto_highlights_result.results.map(h => ({
          text: h.text,
          count: h.count,
          rank: h.rank,
          timestamps: h.timestamps || []
        })) : [],
        sentiments: Array.isArray(d.sentiment_analysis_results) ? d.sentiment_analysis_results.map(s => ({
          text: s.text,
          start: s.start,
          end: s.end,
          sentiment: s.sentiment,
          confidence: s.confidence
        })) : []
      };
    }
    if (d.status === 'error') throw new Error(d.error || 'AssemblyAI error');
  }
}

// ============ Endpoints ============

// إرسال نص عادي (مع سياق)
app.post('/chat', upload.none(), async (req, res) => {
  try {
    const userText = (req.body?.message || '').toString().trim();
    conversationHistory.push({ role: 'user', content: userText });
    trimHistory();

    const reply = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: conversationHistory,
      temperature: 0.4
    });

    const botResponse = reply.choices[0].message.content.trim();
    conversationHistory.push({ role: 'assistant', content: botResponse });
    trimHistory();

    res.json({ ok: true, response: botResponse, extra: {} });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// رفع صورة → تحليل تفصيلي
app.post('/upload-image', upload.single('image'), async (req, res) => {
  const localPath = req.file?.path;
  const prompt = req.body?.prompt || '';

  if (!localPath) return res.status(400).json({ ok: false, error: 'لم يتم رفع الصورة' });

  try {
    const vision = await visionDescribeLocal([localPath], prompt);

    // تقرير نصي مفصل جاهز للعرض في الشات
    const responseText = `🔎 تحليل تفصيلي للصورة:\n\n${vision}`;

    res.json({
      ok: true,
      response: responseText,
      extra: { frames: [], transcript: '', frames_meta: [], audio: null }
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  } finally {
    if (localPath) fsp.unlink(localPath).catch(() => {});
  }
});

// رفع فيديو → تقرير تفصيلي (بصري + صوتي إن وجد)
app.post('/upload-video', upload.single('video'), async (req, res) => {
  const videoPath = req.file?.path;
  const prompt = req.body?.prompt || '';

  if (!videoPath) return res.status(400).json({ ok: false, error: 'لم يتم رفع الفيديو' });

  let audioPath;
  try {
    // فريمات + تايملاين تقريبي
    const { frames, framesMeta, duration } = await extractSmartFramesWithMeta(videoPath);

    // تحليل بصري تفصيلي للفريمات
    const vision = await visionDescribeLocal(frames, prompt);

    // محاولة استخراج الصوت (وقد لا يوجد)
    let transcript = '';
    let audioDetails = null;

    try {
      audioPath = path.join(UPLOAD_DIR, `${Date.now()}-audio.mp3`);
      await extractAudio(videoPath, audioPath);
      const t = await transcribeWithAssemblyAI(audioPath);
      transcript = t.text || '';
      audioDetails = t;
    } catch {
      // لا صوت/فشل استخراج الصوت → نكمل بدون صوت
      transcript = '';
      audioDetails = null;
    }

    // تقرير تفصيلي نهائي
    const framesLines = framesMeta.map((m, i) =>
      `- فريم #${i + 1} عند ~${m.t.toFixed(1)} ثانية`
    ).join('\n');

    const finalPrompt = `
لديك تحليل بصري من لقطات موزّعة زمنيًا + نص صوتي (إن وُجد). اكتب **تقريرًا تفصيليًا** بالعربية بتقسيمات واضحة:

1) ملخص تنفيذي (2–4 جُمل).
2) تفاصيل المشاهد بالترتيب الزمني: اذكر التوقيت التقريبي لكل فقرة بالاعتماد على الفريمات:
${framesLines}

اشرح العناصر الظاهرة، النصوص/الأختام، الشعارات، الأشخاص/الأغراض، وحركة الكاميرا إن وجدت.
3) نصوص مقروءة من الشاشة (إن وُجدت) بشكل نقاط منظمة.
4) تحليل الصوت (إن وُجد): الموضوعات، المتحدثون، النقاط الأساسية، مشاعر عامة، أرقام/تواريخ مهمّة.
5) مؤشرات مهمة/مخاطر/امتثال (إن وجدت).
6) أسئلة متابعة مقترحة.
7) توصيات عملية موجّهة.

المادة البصرية (مختصر التحليل):
${vision}

النص الصوتي المستخرج (قد يكون فارغًا):
${transcript || '(لا يوجد صوت/تم تخطيه)'}
    `.trim();

    const reply = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [...conversationHistory, { role: 'user', content: finalPrompt }],
      temperature: 0.25
    });

    const botResponse = reply.choices[0].message.content.trim();
    conversationHistory.push({ role: 'assistant', content: botResponse });
    trimHistory();

    res.json({
      ok: true,
      response: botResponse,
      extra: {
        frames,
        transcript,
        frames_meta: framesMeta,
        duration,
        audio: audioDetails
      }
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  } finally {
    await cleanDir(FRAMES_DIR).catch(() => {});
    if (audioPath) fsp.unlink(audioPath).catch(() => {});
    if (videoPath) fsp.unlink(videoPath).catch(() => {});
  }
});

// رفع صوت منفصل → تقرير تفصيلي للصوت
app.post('/upload-audio', upload.single('audio'), async (req, res) => {
  const audioPath = req.file?.path;
  if (!audioPath) return res.status(400).json({ ok: false, error: 'لم يتم رفع الملف الصوتي' });

  try {
    const t = await transcribeWithAssemblyAI(audioPath);
    const transcript = t.text || '';

    const prompt = `
لدينا نص صوتي مُفرّغ. أعد **تحليلًا تفصيليًا** بالعربية يتضمن:
- ملخص تنفيذي مركز.
- النقاط الرئيسية مرتبة.
- تقسيم موضوعي/زمني موجز.
- المتحدثون (إن وُجدوا) وأبرز مساهماتهم.
- المشاعر العامة وأي لحظات لافتة (سلبية/إيجابية).
- أرقام/تواريخ/توصيات عملية.
- أسئلة متابعة مقترحة.

النص:
${transcript}
    `.trim();

    const reply = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [...conversationHistory, { role: 'user', content: prompt }],
      temperature: 0.25
    });

    const botResponse = reply.choices[0].message.content.trim();
    conversationHistory.push({ role: 'assistant', content: botResponse });
    trimHistory();

    res.json({
      ok: true,
      response: botResponse,
      extra: {
        frames: [],
        transcript,
        frames_meta: [],
        audio: t
      }
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  } finally {
    if (audioPath) fsp.unlink(audioPath).catch(() => {});
  }
});


