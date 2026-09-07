import ollama


response = ollama.chat(
    model="qwen3:4b",
    messages=[
        {
            "role": "user",
            "content": "Hello, introduce yourself in one sentence."
        }
    ]
)


print(response["message"]["content"])