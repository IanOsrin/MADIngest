#!/bin/bash

SOURCE="/Users/fmserver/Documents/Vision.localized/gallo-music-files-wavs/CCA DDEX/20260416120010379"
DEST="/Users/fmserver/Documents/Vision.localized/gallo-music-files-wavs/CCA DDEX/20260416120010379 Artwork"

find "$SOURCE" -type f -iname "*.jpg" | while read -r file; do
    mv "$file" "$DEST/"
    echo "Moved: $(basename "$file")"
done

echo "Done."
