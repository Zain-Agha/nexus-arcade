import Groq from 'groq-sdk';

const apiKey = process.env.NEXT_PUBLIC_GROQ_API_KEY || process.env.GROQ_API_KEY || '';

export async function generateGameAnnounce(game: string, event: string): Promise<string> {
  // If no Groq key is provided yet, return instant fun arcade fallbacks!
  if (!apiKey) {
    const fallbacks = [
      "BOOM! Unbelievable shot!",
      "Direct hit on the fortress heart!",
      "Sensational play under high pressure!",
      "What a destructive maneuver!"
    ];
    return fallbacks[Math.floor(Math.random() * fallbacks.length)];
  }

  try {
    const groq = new Groq({
      apiKey: apiKey,
      dangerouslyAllowBrowser: true,
    });

    const chatCompletion = await groq.chat.completions.create({
      messages: [
        {
          role: 'system',
          content: 'You are NEXUS AI, an energetic, funny, hyper-arcade game announcer! Keep responses under 15 words with emojis.',
        },
        {
          role: 'user',
          content: `Announce this moment in ${game}: ${event}`,
        },
      ],
      model: 'llama-3.3-70b-versatile',
    });

    return chatCompletion.choices[0]?.message?.content || 'EPIC PLAY!';
  } catch (err) {
    console.warn('Groq AI Announcer fallback activated:', err);
    return 'CRITICAL DAMAGE DEALT!';
  }
}