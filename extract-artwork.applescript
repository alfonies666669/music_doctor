-- Reads one artwork in its original format without changing the track.
on run argv
    set wantedID to item 1 of argv
    set outputPath to item 2 of argv
    tell application "/System/Applications/Music.app"
        set matches to (every file track of library playlist 1 whose persistent ID is wantedID)
        if (count of matches) is not 1 then error "Track ID is not unique"
        set pictures to artworks of item 1 of matches
        if (count of pictures) is not 1 then error "Artwork is ambiguous"
        set artworkBytes to raw data of item 1 of pictures
    end tell
    set handle to open for access POSIX file outputPath with write permission
    try
        set eof handle to 0
        write artworkBytes to handle
        close access handle
    on error messageText number errorNumber
        close access handle
        error messageText number errorNumber
    end try
end run
