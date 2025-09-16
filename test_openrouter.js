const OpenAI = require('openai');

// Test OpenRouter API directly
const client = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: "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",
});

async function testOpenRouterModels() {
  const models = [
    'openrouter/anthropic/claude-3.7-sonnet:thinking',
    'openrouter/meta-llama/llama-4-maverick:free',
    'openrouter/meta-llama/llama-4-scout:free',
    'openrouter/moonshotai/kimi-vl-a3b-thinking:free'
  ];

  for (const model of models) {
    console.log(`\n=== Testing ${model} ===`);
    
    try {
      const completion = await client.chat.completions.create({
        model: model,
        messages: [
          {
            role: "system",
            content: "You are a helpful assistant that performs computer tasks. When given a task, respond with structured content that includes your reasoning and actions."
          },
          {
            role: "user",
            content: "Please help me open a web browser. Describe what you would do step by step."
          }
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "computer_action",
              description: "Perform a computer action",
              parameters: {
                type: "object",
                properties: {
                  action: {
                    type: "string",
                    enum: ["click", "type", "key", "screenshot"]
                  },
                  coordinates: {
                    type: "array",
                    items: { type: "number" }
                  },
                  text: { type: "string" }
                }
              }
            }
          }
        ],
        tool_choice: "auto"
      });

      console.log('Response structure:');
      console.log('- ID:', completion.id);
      console.log('- Model:', completion.model);
      console.log('- Choices length:', completion.choices?.length || 0);
      
      if (completion.choices && completion.choices.length > 0) {
        const choice = completion.choices[0];
        console.log('- Finish reason:', choice.finish_reason);
        console.log('- Message role:', choice.message?.role);
        console.log('- Message content length:', choice.message?.content?.length || 0);
        console.log('- Tool calls:', choice.message?.tool_calls?.length || 0);
        
        if (choice.message?.content) {
          console.log('- Content preview:', choice.message.content.substring(0, 200) + '...');
        }
        
        if (choice.message?.tool_calls) {
          console.log('- Tool calls:', JSON.stringify(choice.message.tool_calls, null, 2));
        }
      }
      
      console.log('\nFull response:');
      console.log(JSON.stringify(completion, null, 2));
      
    } catch (error) {
      console.error(`Error testing ${model}:`, error.message);
      if (error.response) {
        console.error('Response status:', error.response.status);
        console.error('Response data:', error.response.data);
      }
    }
  }
}

testOpenRouterModels().catch(console.error);