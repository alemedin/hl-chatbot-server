const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { OpenAI } = require('openai');

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// Optional homepage route
app.get('/', (req, res) => {
  res.send('✅ Chatbot server is live and ready.');
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

app.post('/chat', async (req, res) => {
  try {
    const messages = req.body.messages;
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: messages,
    });
    res.json(completion.choices[0].message);
  } catch (error) {
    console.error('OpenAI error:', error);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
