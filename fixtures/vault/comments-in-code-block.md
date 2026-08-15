---
publish: true
share_id: 9v3n6r7k2m9x4qp8
title: Comments in a code block
---

# Comments in a code block

This is the fixture that stops a regex implementation passing (§11.2). A naive
stripper pairs the `%%` inside the fence below with the one in the paragraph
*after* it, and silently swallows everything in between.

```erlang
%% In Erlang, %% starts a comment.
main() ->
    io:format("~p~n", [ok]).
%% Two of them, unpaired with anything.
```

And an inline span: `%%` must survive here too.

A real comment follows, and it %%must be removed%% without touching the block.

    %% An indented code block also counts as code.
    still_code().
