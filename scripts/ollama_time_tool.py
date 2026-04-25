from __future__ import annotations

from datetime import datetime

from ollama import chat


def get_current_time() -> str:
    """Return the current local system time."""
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def main() -> None:
    messages = [
        {
            "role": "user",
            "content": "现在几点？请使用工具回答，并在回答里带上完整日期和时间。",
        }
    ]

    first_response = chat(
        model="qwen3:4b-thinking",
        messages=messages,
        tools=[get_current_time],
    )

    messages.append(first_response.message)

    tool_calls = first_response.message.tool_calls or []
    for call in tool_calls:
        if call.function.name == "get_current_time":
            result = get_current_time()
            messages.append(
                {
                    "role": "tool",
                    "tool_name": call.function.name,
                    "content": result,
                }
            )

    final_response = chat(
        model="qwen3:4b-thinking",
        messages=messages,
        tools=[get_current_time],
    )

    print(final_response.message.content)


if __name__ == "__main__":
    main()
