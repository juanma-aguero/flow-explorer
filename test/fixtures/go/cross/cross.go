package cross

import (
	"fmt"
	"strings"

	"example.com/flowfix/shapes"
)

type Greeter interface {
	Greet(name string) string
}

type English struct{}

func (English) Greet(name string) string { return "Hello " + name }

func Run(g Greeter, name string, handlers map[string]func(), cb func()) string {
	msg := g.Greet(name)
	local := helper(msg)
	text := strings.ToUpper(local)
	fmt.Println(text)
	handlers["x"]()
	cb()
	shapes.Sequence(1)
	var e English
	return e.Greet(text)
}

func helper(s string) string { return s + "!" }

func Fact(n int) int {
	if n <= 1 {
		return 1
	}
	return n * Fact(n-1)
}

func Ping(n int) int { return Pong(n) }
func Pong(n int) int { return Ping(n) }
