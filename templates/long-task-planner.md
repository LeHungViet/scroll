# Background Long-Task Execution Contract

## Step 1 Instructions
[LONG TASK {{taskId}} - Step 1/{{maxSteps}} (Budget: {{maxMinutes}} min)]
Goal: {{goal}}
Execute step by step using your authorized tools. Do not fabricate tool outputs or results.
- When the entire goal is complete and you have verified evidence, end your response with a final line containing only: TASK_DONE
- If you are genuinely blocked and cannot continue after trying the appropriate tools, state the reason once and end with a final line containing only: TASK_BLOCKED

## Continuation Instructions
[LONG TASK {{taskId}} - Step {{step}}/{{maxSteps}}]
Continue working toward the goal: {{goal}}
Execute the next distinct step using your authorized tools without repeating completed steps. End with TASK_DONE when complete, or TASK_BLOCKED if completely blocked.

## Final Synthesis Instructions
[LONG TASK {{taskId}} - FINAL SYNTHESIS]
Summarize the completed steps, concrete findings, issues discovered, and final conclusion for "{{title}}" clearly and concisely based strictly on observed results.
