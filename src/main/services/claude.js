const Anthropic = require('@anthropic-ai/sdk');

class ClaudeService {
  constructor(store) {
    this.store = store;
    this.client = null;
    this.initializeClient();
  }

  initializeClient() {
    const apiKey = this.store.get('claude.apiKey') || process.env.ANTHROPIC_API_KEY;
    if (apiKey) {
      this.client = new Anthropic({ apiKey });
    }
  }

  setApiKey(apiKey) {
    this.store.set('claude.apiKey', apiKey);
    this.client = new Anthropic({ apiKey });
  }

  isConfigured() {
    return !!this.client;
  }

  async summarize(content, type, prompt, useSonnet = false) {
    if (!this.client) {
      throw new Error('Claude API key not configured');
    }

    const systemPrompts = {
      gmail: `You are a helpful assistant that summarizes email data. Be concise and focus on what matters most to the user. Format your response in clear sections with bullet points where appropriate.`,
      whatsapp: `You are a helpful assistant that summarizes WhatsApp conversations. Identify key topics discussed, important messages, and the overall sentiment. Be concise and respect privacy - focus on topics rather than personal details.`,
      notion: `You are a helpful assistant that summarizes Notion workspace content. Focus on recent activity, key themes, and progress on journaling or documentation efforts.`
    };

    const model = useSonnet ? 'claude-sonnet-4-20250514' : 'claude-3-5-haiku-20241022';

    try {
      const response = await this.client.messages.create({
        model,
        max_tokens: 1024,
        system: systemPrompts[type] || 'You are a helpful assistant.',
        messages: [
          {
            role: 'user',
            content: prompt + '\n\nHere is the data:\n' + JSON.stringify(content, null, 2)
          }
        ]
      });

      return response.content[0].text;
    } catch (error) {
      console.error('Claude API error:', error);
      throw error;
    }
  }

  async generateTodaySummary(data, type) {
    const prompts = {
      gmail: `Summarize today's emails concisely:

**Overview**: X emails today, mostly from [top 2-3 senders]. Y need your attention.

**Needs Action**:
- **Sender Name** - Subject: Brief 1-line context of what they need

RULES:
- NO tables or category breakdowns
- Only list emails that actually need a response/action
- If no emails need action, say "Nothing urgent today"`,

      whatsapp: `Write a natural 2-3 sentence summary for each active chat.

Format:
**Chat Name**
Natural flowing sentences describing what was discussed. Include specific details like names, dates, decisions.

Examples:

**Family Fun Chat**
Everyone wished Tanushree happy birthday and shared memories from her party last weekend. Mom suggested getting a gold necklace as a gift and most people agreed. Dad mentioned planning a Goa trip for February.

**Work Team**
The product launch is confirmed for Monday at 10am. Sarah presented the client demo and they loved it but want the header color changed to blue.

**Priya**
Caught up after a long time - she got promoted to Senior Manager at Deloitte! Planning to meet for dinner at the new Italian place next Saturday.

RULES:
- Write naturally like you're telling a friend what happened
- Include WHO said WHAT and any DECISIONS made
- NO "they discussed X" or "there was discussion about X" - just state what happened
- NO generic summaries - be specific with names, places, dates
- Skip chats with only greetings or "ok/haha" messages`,

      notion: `Summarize today's Notion activity briefly:

**Overview**: X pages edited today.

**Recent Activity**:
- Page name: Brief description of what was added/changed

Keep it concise.`
    };

    return this.summarize(data, type, prompts[type], true); // Use Sonnet for daily summaries
  }

  async generateWeekSummary(data, type) {
    const prompts = {
      gmail: `Summarize this week's emails:

**Overview**: X emails this week, mostly from [top senders]. Y still need attention.

**Important This Week**:
- **Sender** - Subject: What it was about / what was decided
- **Sender** - Subject: Brief context

**Still Pending**:
- **Sender** - Subject: What they're waiting for from you

Example:
**Overview**: 45 emails this week, mostly from work (HR, John, Sarah) and newsletters. 3 still need attention.

**Important This Week**:
- **John** - Q4 Budget: Approved the revised numbers, project greenlit
- **Sarah** - Client Meeting: Rescheduled to Thursday 2pm

**Still Pending**:
- **HR** - Benefits: Need your selection by Friday
- **Boss** - Report: Asked for status update, hasn't been replied

RULES:
- NO tables
- NO category breakdowns
- NO "top contacts" section
- Focus on what matters: important decisions and pending items`,

      whatsapp: `Write a natural summary for each active chat THIS WEEK.

Format:
**Chat Name**
3-5 sentences describing what happened this week. Include names, dates, decisions, and outcomes.

Examples:

**Family Fun Chat**
Big week! Finalized Thanksgiving dinner at Grandma's house for Thursday 4pm - everyone's bringing a dish. Uncle Bob's surgery went well on Tuesday and he's recovering at home. Mom is visiting him Saturday and asked if anyone wants to join. Also started planning Christmas gifts - budget is $50 per person this year.

**College Friends**
Finally locked in the reunion date - December 20th at Mike's place, starts at 7pm. Everyone celebrated John's promotion to Senior Developer at Google! Sarah can't make the reunion but wants to video call in.

**Pending questions you haven't answered**:
- Mom asked if you're bringing dessert to Thanksgiving
- Mike needs headcount for reunion by Friday

RULES:
- Write naturally like catching up a friend on what happened
- Include WHO said/did WHAT, WHEN, and any DECISIONS
- NO "there was discussion about" or "they talked about" - state facts directly
- Only show "Pending" section if there are actual unanswered questions directed at the user`,

      notion: `Based on this week's Notion activity, provide a comprehensive well-formatted summary:

## 📝 Weekly Overview
Brief overview of your workspace activity this week.

## ✏️ Pages & Edits
| Page | Activity | Last Updated |
|------|----------|--------------|
| Page name | Created/Edited | Date |

## 🌟 My Journey This Week
### Themes
Key themes that emerged from your entries this week.

### Notable Entries
- **Entry title**: Brief summary of what you wrote about

### Mood & Patterns
Any patterns in your journaling (topics, frequency, tone).

## 💡 Insights & Reflections
Notable insights or recurring thoughts from this week.

## 🎯 Suggestions
Ideas for future entries or areas to explore.

Use markdown formatting for a clean, readable summary.`
    };

    return this.summarize(data, type, prompts[type], true); // Use Sonnet for weekly summaries
  }

  async generateActionItems(data, type) {
    const prompts = {
      gmail: `List action items from these emails as simple todo items.

Format each as a clear task starting with a verb:
- Reply to John about the project deadline
- Review the contract from HR by Friday
- Send Sarah the meeting notes she requested

RULES:
- Start each item with an action verb (Reply, Send, Review, Call, Schedule, etc.)
- Include WHO and WHAT in each item
- NO metadata like "From:", "Urgency:", "Priority:"
- NO numbered lists - just bullet points
- Only include items that actually need action
- If nothing needs action, say "No action items right now"`,

      whatsapp: `List ONLY specific action items from these WhatsApp messages.

Good examples (SPECIFIC):
- Reply to Mom about whether you're bringing dessert on Saturday
- Send Raj the Goa trip photos he asked for
- Tell the group your answer about the Friday dinner plan
- Call Dad back - he asked you to call about the car

Bad examples (TOO VAGUE - do NOT include):
- "Check messages"
- "Respond to group"
- "Follow up with family"
- "Review conversations"
- "Stay connected"
- "Keep in touch"

RULES:
- ONLY include items where someone specifically asked YOU something
- Must have a specific person AND specific topic
- NO vague items like "respond to messages" or "check updates"
- NO generic relationship advice like "stay in touch"
- If no SPECIFIC action items exist, say "No action items right now"`,

      notion: `List suggested actions based on this Notion activity.

Format as simple tasks:
- Continue writing the journal entry from Monday
- Review and organize the project notes
- Add details to the trip planning page

RULES:
- Write as clear, actionable tasks
- NO metadata or labels
- NO numbered lists - just bullet points
- If nothing needs action, say "No action items right now"`
    };

    return this.summarize(data, type, prompts[type]);
  }

  async answerQuestion(data, type, question) {
    const prompts = {
      gmail: `The user is asking about their emails. Answer this question based on the email data provided: "${question}"

Be specific and reference actual emails when possible. If the information isn't in the data, say so.`,

      whatsapp: `The user is asking about their WhatsApp conversations. Answer this question based on the chat data provided: "${question}"

Be specific and reference actual chats or messages when possible. Respect privacy - focus on topics rather than personal details. If the information isn't in the data, say so.`,

      notion: `The user is asking about their Notion workspace. Answer this question based on the Notion data provided: "${question}"

Be specific and reference actual pages or entries when possible. If the information isn't in the data, say so.`
    };

    return this.summarize(data, type, prompts[type]);
  }

  async getTopicDetails(topic, chatName, messagesData) {
    if (!this.client) {
      throw new Error('Claude API key not configured');
    }

    try {
      const response = await this.client.messages.create({
        model: 'claude-3-5-haiku-20241022',
        max_tokens: 200,
        system: `Give facts only. No preamble. No "In the X group, there was discussion about Y" - just state what happened.

Example BAD: "In the Family Chat group, there was discussion about dinner plans in the context of..."
Example GOOD: "Mom suggested Italian for Saturday. Dad prefers Thai. Decision pending - Mom asked everyone to vote by Friday."

Rules:
- Start directly with the facts
- 2-3 sentences max
- Names, times, decisions only
- No meta-commentary about the conversation`,
        messages: [
          {
            role: 'user',
            content: `Topic: "${topic}"

What specifically happened? Just the facts:

${JSON.stringify(messagesData, null, 2)}`
          }
        ]
      });

      return response.content[0].text;
    } catch (error) {
      console.error('Topic details error:', error);
      throw error;
    }
  }

  async generateCombinedSummary(allData) {
    if (!this.client) {
      throw new Error('Claude API key not configured');
    }

    const prompt = `Create a daily overview from the user's data:

**ACTION ITEMS**
List 3-5 specific things needing attention today:
1. [Source] Specific action - brief context

Example:
1. [WhatsApp] Reply to Mom about Saturday dinner - she asked if you're bringing dessert
2. [Gmail] Review contract from John - deadline tomorrow
3. [Notion] Complete journal entry for Monday

RULES:
- NO "you have X unread messages" statements
- NO "busy day" or "active communications" filler
- NO vague items like "check messages" or "review updates"
- Each action must be SPECIFIC with names/context
- Only include actionable items, not FYI updates
- Skip sources with nothing actionable

Data:
${JSON.stringify(allData, null, 2)}`;

    try {
      const response = await this.client.messages.create({
        model: 'claude-3-5-haiku-20241022',
        max_tokens: 1024,
        system: 'You are a helpful personal assistant that provides concise, actionable daily summaries. Be direct and prioritize what matters most.',
        messages: [
          {
            role: 'user',
            content: prompt
          }
        ]
      });

      return response.content[0].text;
    } catch (error) {
      console.error('Claude combined summary error:', error);
      throw error;
    }
  }
}

module.exports = ClaudeService;
