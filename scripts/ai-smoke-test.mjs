const endpoint = process.env.DRIVIA_CHAT_TEST_URL || "http://localhost:3000/api/chat";

const questions = [
  {
    prompt: "What is a turbocharger?",
    topic: /turbo|compress|exhaust|boost/i,
  },
  {
    prompt: "Compare BMW M3 and Audi RS5.",
    topic: /BMW|M3/i,
    also: /Audi|RS5/i,
  },
  {
    prompt: "Why are EVs so fast?",
    topic: /electric|motor|torque|battery/i,
  },
  {
    prompt: "Is a used Porsche 911 expensive to maintain?",
    topic: /Porsche|911|maint|service|cost/i,
  },
  {
    prompt: "Explain AWD like I'm 10.",
    topic: /AWD|all.?wheel|wheel|traction/i,
  },
  {
    prompt: "What's the best daily sports car?",
    topic: /daily|sport|car|driver/i,
  },
  {
    prompt: "Tell me about the history of the Nissan GT-R.",
    topic: /Nissan|GT.?R|Skyline/i,
  },
  {
    prompt: "I have $40,000. What car should I consider?",
    topic: /budget|\$|40,?000|40k|car|used/i,
  },
];

async function ask(messages) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({ messages }),
    signal: AbortSignal.timeout(90_000),
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(`${response.status}: ${payload?.error || "AI endpoint returned an error"}`);
  }
  if (!response.headers.get("content-type")?.includes("text/event-stream") || !response.body) {
    throw new Error("The endpoint did not return an SSE stream.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let reply = "";
  let complete = false;

  const processFrame = (frame) => {
    let eventName = "message";
    const dataLines = [];

    for (const line of frame.split("\n")) {
      if (line.startsWith("event:")) eventName = line.slice(6).trim();
      if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }

    if (!dataLines.length) return false;
    const data = dataLines.join("\n");
    if (data === "[DONE]") return true;

    const payload = JSON.parse(data);
    if (eventName === "error" || typeof payload.error === "string") {
      throw new Error(payload.error || "The model stream reported an error.");
    }
    if (typeof payload.delta === "string") reply += payload.delta;
    return eventName === "done";
  };

  while (!complete) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    buffer = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

    let separatorIndex = buffer.indexOf("\n\n");
    while (separatorIndex !== -1) {
      complete = processFrame(buffer.slice(0, separatorIndex));
      buffer = buffer.slice(separatorIndex + 2);
      if (complete) break;
      separatorIndex = buffer.indexOf("\n\n");
    }

    if (done) {
      if (!complete && buffer.trim()) complete = processFrame(buffer);
      break;
    }
  }

  reader.releaseLock();
  if (!complete || reply.trim().length < 40) {
    throw new Error("The model stream ended without a complete, useful response.");
  }

  return reply.trim();
}

try {
  const replies = [];

  for (const { prompt, topic, also } of questions) {
    const reply = await ask([{ role: "user", content: prompt }]);
    if (!topic.test(reply) || (also && !also.test(reply))) {
      throw new Error(`The response did not address the topic in: "${prompt}"`);
    }
    replies.push(reply);
    console.log(`\nQ: ${prompt}\nDRIVIA: ${reply}`);
  }

  const uniqueReplies = new Set(replies.map((reply) => reply.toLowerCase().replace(/\s+/g, " ")));
  if (uniqueReplies.size !== questions.length) {
    throw new Error("At least two different questions received the same response.");
  }

  let conversation = [{ role: "user", content: "Tell me about the BMW M3." }];
  const m3Intro = await ask(conversation);
  conversation = [...conversation, { role: "assistant", content: m3Intro }];

  conversation = [...conversation, { role: "user", content: "Is it reliable?" }];
  const reliability = await ask(conversation);
  conversation = [...conversation, { role: "assistant", content: reliability }];

  conversation = [...conversation, { role: "user", content: "What about the Mercedes C63?" }];
  const c63 = await ask(conversation);
  conversation = [...conversation, { role: "assistant", content: c63 }];

  conversation = [...conversation, { role: "user", content: "Which one would you choose for everyday driving, and why?" }];
  const followUp = await ask(conversation);
  if (!/BMW|M3/i.test(followUp) || !/Mercedes|C\s?63|AMG/i.test(followUp)) {
    throw new Error("The follow-up response did not retain the M3 vs C63 context.");
  }
  console.log(`\nContext check: "Is it reliable?" -> M3, then C63\nDRIVIA: ${followUp}`);
  console.log("\nPASS: eight different live answers and the conversation-context check succeeded.");
} catch (error) {
  console.error(`\nFAIL: ${error instanceof Error ? error.message : "AI smoke test failed."}`);
  console.error(`Chat endpoint: ${endpoint}`);
  console.error("Start the serverless chat route and configure a real provider key before running this test.");
  process.exitCode = 1;
}