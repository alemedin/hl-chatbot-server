const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { Configuration, OpenAIApi } = require('openai');

const app = express();
const port = process.env.PORT || 10000;

app.use(cors());
app.use(bodyParser.json());

// Load OpenAI API key from environment variable
const configuration = new Configuration({
  apiKey: process.env.OPENAI_API_KEY,
});

const openai = new OpenAIApi(configuration);

app.post('/chat', async (req, res) => {
  try {
    const { messages } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'Invalid messages format' });
    }

    const completion = await openai.createChatCompletion({
      model: 'gpt-4o', // Change this if you want to use a different model
      messages,
    });

    res.json({ response: completion.data.choices[0].message.content });
  } catch (error) {
    console.error('Error forwarding message to OpenAI:', error.response?.data || error.message || error);
    res.status(500).json({ error: error.response?.data || error.message || 'Unknown error' });
  }
});

app.listen(port, () => {
  console.log(`✅ Server listening on port ${port}`);
});
