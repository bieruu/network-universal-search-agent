from pydantic import BaseModel


class SourceError(BaseModel):
    source: str
    message: str
