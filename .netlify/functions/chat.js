export async function handler(event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const API_KEY = process.env.CLAUDE_API_KEY;
  if (!API_KEY) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "API key not configured" }),
    };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON" }) };
  }

  const { message, stage, conversationHistory } = body;

  // Build system prompt based on stage
  const stageInfo = [
    { stage: 1, label: "1.1", title: "Establishing Self-Care" },
    { stage: 2, label: "1.2", title: "Regulating Attention" },
    { stage: 3, label: "1.3", title: "Understanding Emotions" },
    { stage: 4, label: "1.4", title: "Applying Mindfulness" },
    { stage: 5, label: "2.1", title: "Regulating Behavior" },
    { stage: 6, label: "2.2", title: "Self-Confidence" },
    { stage: 7, label: "3.1", title: "Interpersonal Mindfulness" },
    { stage: 8, label: "3.2", title: "Mindful Communication" },
    { stage: 9, label: "4.1", title: "Cultivating Compassion" },
    { stage: 10, label: "4.2", title: "Maintaining Well-Being" },
  ];

  const currentStageInfo = stageInfo[stage - 1] || stageInfo[0];

  const systemPrompt = `You are a warm, knowledgeable Help & Support assistant for the MiCBT Guide app. You help users with questions about the app and MiCBT program.

The user is currently on Stage ${currentStageInfo.label}: ${currentStageInfo.title}

Guidelines:
- You are not a therapist, doctor, or counselor
- Speak with warmth, curiosity, and grounded calm
- Use plain, accessible language
- Never diagnose, prescribe, or give clinical advice
- Answer questions about the app, MiCBT techniques, assessments, and practice
- For clinical concerns, direct them to a healthcare professional`;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-3-5-haiku-20241022",
        max_tokens: 1024,
        system: systemPrompt,
        messages: conversationHistory || [
          { role: "user", content: message }
        ],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      return {
        statusCode: response.status,
        body: JSON.stringify({ error: err }),
      };
    }

    const data = await response.json();
    const reply = data.content[0].text;

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reply }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
}
