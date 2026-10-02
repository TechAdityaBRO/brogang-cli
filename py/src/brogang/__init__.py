"""BRO GANG AI CLI - a free, open source AI coding agent for your terminal.

Install with pip, poetry or uv:

    pip install brogang-cli
    poetry add brogang-cli
    uv pip install brogang-cli

and run:

    brogang
"""

__version__ = "0.1.0"

from .agent import Agent, CancelledError, MaxStepsError, SystemPrompt
from .config import Config, default_config, load, save
from .provider import (
    Anthropic,
    CompletionRequest,
    CompletionResponse,
    Message,
    OpenAICompatible,
    Provider,
    ToolCall,
    ToolSpec,
    registry,
)
from .tools import ToolRegistry, run_command_tool, read_file_tool

__all__ = [
    "Agent",
    "Anthropic",
    "CancelledError",
    "CompletionRequest",
    "CompletionResponse",
    "Config",
    "MaxStepsError",
    "Message",
    "OpenAICompatible",
    "Provider",
    "SystemPrompt",
    "ToolCall",
    "ToolRegistry",
    "ToolSpec",
    "default_config",
    "load",
    "read_file_tool",
    "registry",
    "run_command_tool",
    "save",
]
