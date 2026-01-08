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
      gmail: `Summarize today's emails in this format:

**Overview**: X emails today, mostly from [top 2-3 senders]. Y need your attention.

**Needs Action**:
- **Sender Name** - Subject: Brief 1-line context of what they need
- **Sender Name** - Subject: What action is required

Example:
**Overview**: 12 emails today, mostly from Amazon, LinkedIn, and John. 2 need your attention.

**Needs Action**:
- **John Smith** - Project Deadline: Asking for your review on the proposal by Friday
- **HR Team** - Benefits Enrollment: Need to select health plan by Dec 15

RULES:
- NO tables
- NO category breakdowns
- NO "key senders" section
- Only list emails that actually need a response/action
- Each action item needs specific context (what do they want?)
- If no emails need action, say "Nothing urgent today"`,

      whatsapp: `Write a brief 2-3 line summary for each active chat TODAY. Make important keywords clickable with [[keyword]].

Format:
**Group/Contact Name**
Natural summary sentence with [[clickable topic]] embedded. Another sentence if needed.

Example:
**Family Fun Chat**
Planning [[Dad's birthday]] this Saturday - Mom suggested the Italian place, waiting for confirmation. Also shared photos from [[last year's trip]] to Goa, everyone feeling nostalgic.

**Work Team**
[[Product launch]] confirmed for Monday 10am. Client loved the [[demo]] but wants the blue changed to green.

**Sarah**
Catching up about her [[new job]] - she started last week and loves it. Making plans for [[coffee]] next Thursday.

RULES:
- Write natural sentences, NOT bullet points of keywords
- Only make 2-3 important/recurring things clickable per chat
- NO keyword dumps like "talked about love, life, work, food"
- NO generic words like "chilling", "random", "stuff"
- The summary should make sense even without clicking anything
- Skip chats with nothing meaningful (just "ok", "haha", etc.)`,

      notion: `Based on today's Notion activity, provide a well-formatted summary using this structure:

## 📝 Overview
A 1-2 sentence overview of today's workspace activity.

## ✏️ Recently Edited
- List of pages edited with brief descriptions

## 🌟 My Journey Highlights
Key themes or entries from the "My Journey" database (if present).

## 💡 Key Insights
Notable patterns or themes from your entries.

Keep it concise but well-organized. Use markdown formatting.`
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

      whatsapp: `Write a summary for each active chat THIS WEEK. Make important topics clickable with [[topic]].

Format:
**Group/Contact Name**
A few sentences summarizing the main things that happened. Embed [[clickable topics]] naturally.

Example:
**Family Fun Chat**
Big week for family planning - finalized [[Thanksgiving]] at Grandma's for Thursday 4pm, everyone's bringing something. [[Uncle Bob]]'s surgery went well and he's recovering at home. Mom's visiting him Saturday.

**College Friends**
Locked in the [[reunion]] for Dec 20th at Mike's place. Also celebrated [[John's promotion]] - he got the senior developer role!

**Pending**:
- Mom asked if you're bringing dessert to Thanksgiving

RULES:
- Write flowing sentences, not keyword lists
- Only 2-4 clickable topics per chat (the important/recurring ones)
- NO "talked about various things" or keyword dumps
- Summary should be readable and meaningful on its own
- Only show Pending if there are real unanswered questions`,

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
      gmail: `Based on these emails, identify ACTION ITEMS that need the user's attention. For each action item:
1. What needs to be done
2. Who it's from
3. Urgency level (High/Medium/Low)

Focus only on emails that clearly require a response, decision, or action. Format as a numbered list. If no clear action items exist, say so.`,

      whatsapp: `Based on these WhatsApp messages, identify ACTION ITEMS that need the user's attention. For each action item:
1. What needs to be done or responded to
2. Which chat/person it's from
3. Urgency level (High/Medium/Low)

Focus on messages that require responses, decisions, or follow-up. Format as a numbered list. If no clear action items exist, say so.`,

      notion: `Based on this Notion activity, identify ACTION ITEMS or suggested next steps. For each item:
1. What should be done next
2. Related page or entry
3. Priority level (High/Medium/Low)

Focus on incomplete items, entries that need follow-up, or suggested journaling prompts. Format as a numbered list. If no clear action items exist, say so.`
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
